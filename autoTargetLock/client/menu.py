# -*- coding: utf-8 -*-
"""Auto Target Lock shared Mods-menu entrypoint for EVE Python 2.7."""

import blue
import const
import evejs_mod_menu as mods
import uthread

from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelMedium


SCAN_INTERVAL_MS = 500
TARGETING_MARGIN = 0.98
MAX_TARGETS_FALLBACK = 8
MAX_DISPLAY_TARGETS = 24

WEAKNESS_PROFILES = (
    ('angel cartel', 'Explosive / Kinetic'),
    ('angel', 'Explosive / Kinetic'),
    ('blood raider', 'EM / Thermal'),
    ('blood', 'EM / Thermal'),
    ('guristas', 'Kinetic / Thermal'),
    ('serpentis', 'Kinetic / Thermal'),
    ('sansha', 'EM / Thermal'),
    ('rogue drone', 'Explosive / Thermal'),
    ('rogue', 'Explosive / Thermal'),
)

_window = None


def _positive_int(value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _nonnegative_int(value):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _read_bool(value, names):
    for name in names:
        if not hasattr(value, name):
            continue
        candidate = getattr(value, name)
        try:
            candidate = candidate() if callable(candidate) else candidate
        except Exception:
            continue
        if candidate is not None:
            return bool(candidate)
    return None


def _read_text(value, names):
    for name in names:
        if not hasattr(value, name):
            continue
        candidate = getattr(value, name)
        try:
            candidate = candidate() if callable(candidate) else candidate
        except Exception:
            continue
        if candidate is not None:
            candidate = str(candidate).strip().lower()
            if candidate:
                return candidate
    return None


def _read_display_text(value, names):
    for name in names:
        if not hasattr(value, name):
            continue
        candidate = getattr(value, name)
        try:
            candidate = candidate() if callable(candidate) else candidate
        except Exception:
            continue
        if candidate is None:
            continue
        if isinstance(candidate, (list, tuple, set)):
            candidate = ' / '.join([str(part).strip() for part in candidate if str(part).strip()])
        else:
            candidate = str(candidate).strip()
        if candidate:
            return candidate
    return None


def _config_record(collection_name, item_id):
    item_id = _positive_int(item_id)
    if item_id is None:
        return None
    try:
        cfg_module = __import__('cfg')
        collection = getattr(cfg_module, collection_name, None)
        getter = getattr(collection, 'Get', None)
        return getter(item_id) if callable(getter) else None
    except Exception:
        return None


def _target_type_id(slim):
    for name in ('typeID', 'typeId', 'shipTypeID', 'shipTypeId'):
        type_id = _positive_int(getattr(slim, name, None))
        if type_id is not None:
            return type_id
    return None


def _target_type_name(slim):
    type_id = _target_type_id(slim)
    type_record = _config_record('invtypes', type_id)
    return (
        _read_display_text(slim, ('typeName', 'shipTypeName')) or
        _read_display_text(type_record, ('name', 'typeName')) or
        ('Type %s' % type_id if type_id is not None else 'Unknown type')
    )


def _target_name(slim, target_ball, type_name):
    return (
        _read_display_text(slim, ('name', 'displayName', 'itemName', 'slimName')) or
        _read_display_text(target_ball, ('name', 'displayName', 'itemName')) or
        type_name
    )


def _target_faction_name(slim):
    direct_name = _read_display_text(
        slim,
        ('factionName', 'npcFaction', 'corporationName', 'corpName', 'ownerName'),
    )
    if direct_name:
        return direct_name

    faction_id = _positive_int(getattr(slim, 'factionID', None))
    faction_record = _config_record('factions', faction_id)
    faction_name = _read_display_text(faction_record, ('name', 'factionName'))
    if faction_name:
        return faction_name

    for name in ('ownerID', 'ownerId', 'corpID', 'corporationID'):
        owner_id = _positive_int(getattr(slim, name, None))
        owner_record = _config_record('eveowners', owner_id)
        owner_name = _read_display_text(owner_record, ('name', 'ownerName'))
        if owner_name:
            return owner_name
    return 'Unknown faction'


def _target_weakness(slim, faction_name, type_name):
    direct_weakness = _read_display_text(
        slim,
        ('weakness', 'weaknesses', 'damageWeakness', 'recommendedDamage', 'preferredDamageType'),
    )
    if direct_weakness:
        return direct_weakness

    search_text = '%s %s' % (faction_name, type_name)
    search_text = search_text.lower()
    for profile_name, weakness in WEAKNESS_PROFILES:
        if profile_name in search_text:
            return weakness
    return 'Unknown'


def _format_distance(distance):
    if distance >= 1000.0:
        return '%.1f km' % (distance / 1000.0)
    return '%.0f m' % distance


def _as_item_id(value):
    if isinstance(value, (tuple, list)) and value:
        value = value[0]
    for name in ('itemID', 'itemId', 'targetID', 'targetId'):
        if hasattr(value, name):
            value = getattr(value, name)
            break
    return _positive_int(value)


def _iter_ids(value):
    if value is None:
        return []
    if isinstance(value, dict):
        value = value.keys()
    try:
        values = list(value)
    except TypeError:
        values = [value]
    result = []
    for item in values:
        item_id = _as_item_id(item)
        if item_id is not None and item_id not in result:
            result.append(item_id)
    return result


def _service_ids(service, names):
    result = []
    for name in names:
        member = getattr(service, name, None)
        if member is None:
            continue
        try:
            value = member() if callable(member) else member
        except Exception:
            continue
        result.extend(_iter_ids(value))
    return result


def _locked_ids(target_service):
    return set(_service_ids(target_service, ('GetTargets', 'GetTargetedByMe', 'GetLockedTargets')))


def _locking_ids(target_service):
    return set(_service_ids(target_service, ('GetTargeting', 'GetTargetsBeingLocked', 'GetLockingTargets')))


def _target_slots(target_service):
    for name in ('GetMaxLockedTargets', 'GetMaxTargets', 'GetMaxTargetCount'):
        member = getattr(target_service, name, None)
        if not callable(member):
            continue
        try:
            result = _positive_int(member())
        except Exception:
            result = None
        if result is not None:
            return result

    try:
        godma = sm.GetService('godma')
        ship_item = godma.GetItem(session.shipid)
        result = _positive_int(getattr(ship_item, 'maxLockedTargets', None))
        if result is not None:
            return result
    except Exception:
        pass

    return MAX_TARGETS_FALLBACK


def _available_target_slots(target_service, locked_count, locking_count):
    # TargetMgr exposes the actual remaining capacity.  It does not include
    # locks that are still pending, so remove those separately before issuing
    # another request.  This prevents repeated requests when the lock queue is
    # slower than this mod's scan interval.
    member = getattr(target_service, 'GetNumAdditionalTargetsAllowed', None)
    if callable(member):
        try:
            result = _nonnegative_int(member())
        except Exception:
            result = None
        if result is not None:
            return max(0, result - locking_count)

    return max(0, _target_slots(target_service) - locked_count - locking_count)


def _is_in_warp(ballpark, own_ship_id):
    # This is the native client check used by the movement service.  Keep the
    # ball-mode fallback for client builds that do not expose InWarp().
    try:
        michelle = sm.GetService('michelle')
        for name in ('InWarp', 'IsPreparingWarp'):
            member = getattr(michelle, name, None)
            if callable(member) and member():
                return True
    except Exception:
        pass

    try:
        destiny = __import__('destiny')
        warp_mode = getattr(destiny, 'DSTBALL_WARP', None)
        if warp_mode is not None:
            ball = ballpark.GetBall(own_ship_id)
            return ball is not None and getattr(ball, 'mode', None) == warp_mode
    except Exception:
        pass

    return False


def _max_targeting_range(target_service):
    for name in ('GetMaxTargetingRange', 'GetMaxTargetRange', 'GetTargetingRange'):
        member = getattr(target_service, name, None)
        if not callable(member):
            continue
        try:
            result = float(member())
        except (TypeError, ValueError, AttributeError):
            result = 0.0
        if result > 0.0:
            return result

    try:
        godma = sm.GetService('godma')
        ship_item = godma.GetItem(session.shipid)
        attribute_id = getattr(const, 'attributeMaxTargetRange', None)
        if attribute_id is not None:
            for name in ('GetAttribute', 'GetAttributeValue'):
                member = getattr(ship_item, name, None)
                if not callable(member):
                    continue
                result = float(member(attribute_id))
                if result > 0.0:
                    return result
    except Exception:
        pass
    return 0.0


def _distance(ballpark, source_id, target_id, target_ball=None):
    for name in ('GetDistance', 'GetDistanceBetween', 'DistanceBetween'):
        member = getattr(ballpark, name, None)
        if not callable(member):
            continue
        try:
            result = float(member(source_id, target_id))
        except (TypeError, ValueError, AttributeError):
            continue
        if result >= 0.0:
            return result

    target_ball = target_ball or ballpark.GetBall(target_id)
    source_ball = ballpark.GetBall(source_id)
    for ball in (target_ball, source_ball):
        if ball is None:
            return None
    for name in ('surfaceDist', 'surfaceDistance', 'distance'):
        result = getattr(target_ball, name, None)
        if result is not None:
            try:
                result = float(result)
            except (TypeError, ValueError):
                continue
            if result >= 0.0:
                return result

    try:
        dx = float(target_ball.x) - float(source_ball.x)
        dy = float(target_ball.y) - float(source_ball.y)
        dz = float(target_ball.z) - float(source_ball.z)
        return (dx * dx + dy * dy + dz * dz) ** 0.5
    except (AttributeError, TypeError, ValueError):
        return None


def _is_non_combat_target(slim):
    # Wrecks and containers can retain an NPC owner, so ownership alone must
    # not make them eligible for the hostile-NPC fallback.
    for name in (
        'isWreck',
        'wreck',
        'isCargoContainer',
        'cargoContainer',
        'isContainer',
        'lootContainer',
    ):
        if _read_bool(slim, (name,)) is True:
            return True

    group_id = getattr(slim, 'groupID', None)
    if group_id is not None:
        try:
            if group_id in getattr(const, 'containerGroupIDs', ()):
                return True
        except Exception:
            pass

        for name in (
            'groupWreck',
            'groupCargoContainer',
            'groupSpawnContainer',
            'groupSecureCargoContainer',
            'groupAuditLogSecureContainer',
            'groupFreightContainer',
            'groupMissionContainer',
        ):
            if group_id == getattr(const, name, None):
                return True

    type_text = _read_text(slim, ('groupName', 'categoryName', 'typeName'))
    if type_text and any(
        token in type_text
        for token in ('wreck', 'cargo container', 'secure container', 'freight container', 'mission container')
    ):
        return True

    return False


def _is_owned_by_player(slim):
    character_id = _positive_int(getattr(session, 'charid', None))
    ship_id = _positive_int(getattr(session, 'shipid', None))
    for name in ('ownerID', 'ownerId', 'controllerID', 'controllerId'):
        owner_id = _positive_int(getattr(slim, name, None))
        if owner_id is not None and owner_id in (character_id, ship_id):
            return True
    return False


def _owned_drone_ids():
    result = set()
    character_id = _positive_int(getattr(session, 'charid', None))
    ship_id = _positive_int(getattr(session, 'shipid', None))
    try:
        drones = sm.GetService('michelle').GetDrones()
        entries = drones.items() if isinstance(drones, dict) else ((None, drone) for drone in drones)
        for drone_key, drone in entries:
            owner_id = _positive_int(getattr(drone, 'ownerID', None))
            controller_id = _positive_int(getattr(drone, 'controllerID', None))
            if owner_id != character_id and controller_id != ship_id:
                continue
            drone_id = _positive_int(getattr(drone, 'droneID', None))
            if drone_id is None:
                drone_id = _positive_int(getattr(drone, 'itemID', None))
            if drone_id is None:
                drone_id = _positive_int(drone_key)
            if drone_id is not None:
                result.add(drone_id)
    except Exception:
        pass
    return result


def _is_npc(slim):
    # Some client target/overview records expose an isNPC field with the
    # default value False even for native NPCs.  Treat that as a hint only;
    # keep checking the native NPC marker/type and owner below.
    for name in ('isNPC', 'isNpc', 'npc', 'nativeNpc'):
        result = _read_bool(slim, (name,))
        if result is True:
            return True

    entity_type = _read_text(
        slim,
        ('npcEntityType', 'entityType', 'npcType', 'npc_class'),
    )
    if entity_type in ('npc', 'pirate', 'drifter', 'concord', 'police', 'customs', 'rat'):
        return True

    for owner_name in ('ownerID', 'ownerId', 'corpID', 'corporationID', 'charID', 'charId'):
        owner_id = _positive_int(getattr(slim, owner_name, None))
        if owner_id is None:
            continue
        try:
            id_checkers = __import__('eve.common.script.sys.idCheckers', fromlist=['IsNPC'])
            if id_checkers.IsNPC(owner_id):
                return True
        except Exception:
            pass
        try:
            cfg_module = __import__('cfg')
            owner = cfg_module.eveowners.Get(owner_id)
            member = getattr(owner, 'IsNPC', None)
            if member is not None:
                return bool(member() if callable(member) else member)
        except Exception:
            continue
    return False


def _is_hostile(ballpark, target_service, item_id, slim):
    # A false isHostile value is not authoritative here.  EveJS native NPC
    # slim records do not carry the browser-only npcEntityType field, and the
    # client can expose a default false flag before the overview/state service
    # has classified the entity.  Only positive friendly signals should stop
    # the fallback checks.
    result = _read_bool(
        slim,
        ('isHostile', 'hostile', 'isAggressive', 'aggressive', 'threat'),
    )
    if result is True:
        return True

    friendly = _read_bool(slim, ('isFriendly', 'friendly', 'isNeutral', 'neutral'))
    if friendly is True:
        return False

    entity_type = _read_text(
        slim,
        ('npcEntityType', 'entityType', 'npcType', 'npc_class'),
    )
    if entity_type in ('concord', 'police', 'customs', 'friendly', 'neutral', 'player'):
        return False

    try:
        state_module = __import__(
            'eve.client.script.parklife.states',
            fromlist=['threatTargetsMe', 'threatAttackingMe'],
        )
        state_service = sm.GetService('stateSvc')
        get_state = getattr(state_service, 'GetState', None)
        if callable(get_state):
            for state_name in ('threatTargetsMe', 'threatAttackingMe'):
                state_id = getattr(state_module, state_name, None)
                if state_id is not None and get_state(item_id, state_id):
                    return True
    except Exception:
        pass

    for service in (ballpark, target_service):
        for name in ('IsHostile', 'IsHostileToMe', 'IsAggressive'):
            member = getattr(service, name, None)
            if not callable(member):
                continue
            try:
                result = member(item_id)
            except Exception:
                continue
            if result is True:
                return True

    # Native NPCs are represented to the client primarily by their NPC owner
    # corporation.  The overview can already show them as hostile even when
    # the threat state has not been populated yet, so an NPC that has not
    # produced a positive friendly signal is a valid combat target fallback.
    return _is_npc(slim)


def _is_structure(slim):
    category_id = getattr(slim, 'categoryID', None)
    structure_category = getattr(const, 'categoryStructure', None)
    return structure_category is not None and category_id == structure_category


def _request_lock(target_service, item_id):
    for name in ('TryLockTarget', 'LockTarget'):
        member = getattr(target_service, name, None)
        if not callable(member):
            continue
        try:
            member(item_id)
            return True
        except Exception:
            return False
    return False


class AutoTargetLockWindow(Window):
    default_windowID = 'AutoTargetLockWindow'
    default_caption = 'Auto Target Lock'
    default_width = 620
    default_height = 460
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._enabled = False
        self._generation = 0
        self._scroll = ScrollContainer(
            parent=self.content,
            align=uiconst.TOALL,
            padding=(8, 2, 8, 8),
        )
        self._body = Container(
            parent=self._scroll,
            align=uiconst.TOTOP,
            height=600,
        )
        self._status = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=32,
            padLeft=10,
            padTop=8,
            text='Auto Target Lock is disabled.',
        )
        self._details = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=44,
            padLeft=10,
            padTop=2,
            text='Hostile NPCs only. Existing locks are never removed.',
        )
        self._toggle_button = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            label='Enable Auto Target Lock',
            func=self._toggle,
            padLeft=10,
            height=32,
        )
        Container(parent=self._body, align=uiconst.TOTOP, height=10)
        EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=24,
            padLeft=10,
            text='Enemy details: name | type | faction | distance | lock state | weakness',
        )
        self._targets = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=470,
            padLeft=10,
            padTop=4,
            text='Enable Auto Target Lock to scan for hostile NPCs.',
        )

    def _toggle(self, *args):
        self._enabled = not self._enabled
        self._generation += 1
        if self._enabled:
            self._toggle_button.SetLabel('Disable Auto Target Lock')
            self._set_status('Auto Target Lock is enabled.')
            self._set_targets([], 'Scanning for hostile NPCs...')
            uthread.new(self._run, self._generation)
        else:
            self._toggle_button.SetLabel('Enable Auto Target Lock')
            self._set_status('Auto Target Lock is disabled.')
            self._set_targets([], 'Enable Auto Target Lock to scan for hostile NPCs.')

    def _set_status(self, text):
        if not getattr(self, 'destroyed', False):
            self._status.SetText(text)

    def _set_details(self, text):
        if not getattr(self, 'destroyed', False):
            self._details.SetText(text)

    def _set_targets(self, records, empty_text=None):
        if getattr(self, 'destroyed', False):
            return
        displayed_count = min(len(records), MAX_DISPLAY_TARGETS)
        line_count = max(2, displayed_count * 2 + (1 if len(records) > MAX_DISPLAY_TARGETS else 0))
        self._targets.height = max(60, line_count * 26 + 20)
        self._body.height = 160 + self._targets.height
        if not records:
            self._targets.SetText(empty_text or 'No hostile NPCs currently in range.')
            return
        lines = []
        for record in records[:MAX_DISPLAY_TARGETS]:
            lines.append(
                '%s [%s]\n  %s | %s | %s | Weak: %s' % (
                    record['name'],
                    record['type'],
                    record['faction'],
                    _format_distance(record['distance']),
                    record['status'],
                    record['weakness'],
                )
            )
        if len(records) > MAX_DISPLAY_TARGETS:
            lines.append('... and %d more hostile NPC(s).' % (len(records) - MAX_DISPLAY_TARGETS))
        self._targets.SetText('\n'.join(lines))

    def _target_records(self, ballpark, target_service, max_range, locked=None, locking=None):
        if max_range <= 0.0:
            return []
        own_ship_id = _positive_int(getattr(session, 'shipid', None))
        if own_ship_id is None:
            return []
        locked = locked if locked is not None else _locked_ids(target_service)
        locking = locking if locking is not None else _locking_ids(target_service)
        owned_drone_ids = _owned_drone_ids()
        records = []
        for item_id, slim in getattr(ballpark, 'slimItems', {}).items():
            item_id = _positive_int(item_id)
            if (
                item_id is None
                or item_id == own_ship_id
                or item_id in owned_drone_ids
                or _is_owned_by_player(slim)
            ):
                continue
            if _is_non_combat_target(slim) or _is_structure(slim) or not _is_npc(slim) or not _is_hostile(ballpark, target_service, item_id, slim):
                continue
            try:
                target_ball = ballpark.GetBall(item_id)
            except Exception:
                target_ball = None
            distance = _distance(ballpark, own_ship_id, item_id, target_ball)
            if distance is None or distance > max_range * TARGETING_MARGIN:
                continue
            type_name = _target_type_name(slim)
            faction_name = _target_faction_name(slim)
            records.append({
                'distance': distance,
                'item_id': item_id,
                'name': _target_name(slim, target_ball, type_name),
                'type': type_name,
                'faction': faction_name,
                'weakness': _target_weakness(slim, faction_name, type_name),
                'status': 'LOCKED' if item_id in locked else 'LOCKING' if item_id in locking else 'AVAILABLE',
            })
        records.sort(key=lambda record: (record['distance'], record['item_id']))
        return records

    def _candidate_targets(self, records, available_slots):
        if available_slots <= 0:
            return []
        return [
            (record['distance'], record['item_id'])
            for record in records
            if record['status'] == 'AVAILABLE'
        ][:available_slots]

    def _scan_and_lock(self):
        try:
            target_service = sm.GetService('target')
            ballpark = sm.GetService('michelle').GetBallpark()
            own_ship_id = _positive_int(getattr(session, 'shipid', None))
            if own_ship_id is not None and _is_in_warp(ballpark, own_ship_id):
                locked_count = len(_locked_ids(target_service))
                self._set_details('Targeting paused while warping. | Locked: %d' % locked_count)
                self._set_targets([], 'Target scan paused while warping.')
                return
            locked_ids = _locked_ids(target_service)
            locking_ids = _locking_ids(target_service)
            locked_count = len(locked_ids)
            locking_count = len(locking_ids)
            max_range = _max_targeting_range(target_service)
            records = self._target_records(
                ballpark,
                target_service,
                max_range,
                locked_ids,
                locking_ids,
            )
            self._set_targets(records)
            available_slots = _available_target_slots(target_service, locked_count, locking_count)
            if available_slots <= 0:
                self._set_details('Targeting paused: target slots full. | Locked: %d | Locking: %d' % (locked_count, locking_count))
                return
            candidates = self._candidate_targets(records, available_slots)
            if not candidates:
                self._set_details('Target range: %.0f m | Locked: %d | Locking: %d | No hostile NPCs in range.' % (max_range, locked_count, locking_count))
                return
            locked = 0
            for distance, item_id in candidates:
                if _request_lock(target_service, item_id):
                    locked += 1
            self._set_details('Target range: %.0f m | Locked: %d | Locking: %d | Lock requests: %d' % (max_range, locked_count, locking_count, locked))
        except Exception as error:
            self._set_details('Target scan unavailable: %s' % error)
            self._set_targets([], 'Target scan unavailable: %s' % error)

    def _run(self, generation):
        while self._enabled and generation == self._generation and not getattr(self, 'destroyed', False):
            self._scan_and_lock()
            blue.pyos.synchro.SleepWallclock(SCAN_INTERVAL_MS)

    def Close(self, *args, **kwargs):
        self._enabled = False
        self._generation += 1
        return Window.Close(self, *args, **kwargs)


def open_window():
    global _window
    if _window is not None and not getattr(_window, 'destroyed', False):
        _window.Maximize()
        return
    _window = AutoTargetLockWindow.Open()


registration = mods.register(
    'autotargetlock',
    {'en': 'Auto Target Lock'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not getattr(_window, 'destroyed', False):
        _window.Close()
    _window = None
