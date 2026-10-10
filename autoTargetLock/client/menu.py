# -*- coding: utf-8 -*-
"""Auto Target Lock shared Mods-menu entrypoint for EVE Python 2.7."""

import blue
import const
import evejs_mod_menu as mods
import uthread

from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelMedium


SCAN_INTERVAL_MS = 500
TARGETING_MARGIN = 0.98
MAX_TARGETS_FALLBACK = 8

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
    default_width = 430
    default_height = 285
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._enabled = False
        self._generation = 0
        self._status = EveLabelMedium(parent=self.content, align=uiconst.TOTOP,
                                      text='Auto Target Lock is disabled.')
        self._details = EveLabelMedium(parent=self.content, align=uiconst.TOTOP,
                                       text='Hostile NPCs only. Existing locks are never removed.')
        self._toggle_button = Button(parent=self.content, align=uiconst.TOTOP,
                                     label='Enable Auto Target Lock', func=self._toggle,
                                     top=18, height=32)
        Container(parent=self.content, align=uiconst.TOTOP, height=12)
        EveLabelMedium(parent=self.content, align=uiconst.TOTOP,
                       text='Uses your current targeting range and available target slots.')

    def _toggle(self, *args):
        self._enabled = not self._enabled
        self._generation += 1
        if self._enabled:
            self._toggle_button.SetLabel('Disable Auto Target Lock')
            self._set_status('Auto Target Lock is enabled.')
            uthread.new(self._run, self._generation)
        else:
            self._toggle_button.SetLabel('Enable Auto Target Lock')
            self._set_status('Auto Target Lock is disabled.')

    def _set_status(self, text):
        if not getattr(self, 'destroyed', False):
            self._status.SetText(text)

    def _set_details(self, text):
        if not getattr(self, 'destroyed', False):
            self._details.SetText(text)

    def _candidate_targets(self, ballpark, target_service, max_range):
        if max_range <= 0.0:
            return []
        own_ship_id = _positive_int(getattr(session, 'shipid', None))
        if own_ship_id is None:
            return []
        locked = _locked_ids(target_service)
        locking = _locking_ids(target_service)
        available_slots = _available_target_slots(target_service, len(locked), len(locking))
        if available_slots <= 0:
            return []
        candidates = []
        for item_id, slim in getattr(ballpark, 'slimItems', {}).items():
            item_id = _positive_int(item_id)
            if item_id is None or item_id == own_ship_id or item_id in locked or item_id in locking:
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
            candidates.append((distance, item_id))
        candidates.sort()
        return candidates[:available_slots]

    def _scan_and_lock(self):
        try:
            target_service = sm.GetService('target')
            ballpark = sm.GetService('michelle').GetBallpark()
            own_ship_id = _positive_int(getattr(session, 'shipid', None))
            if own_ship_id is not None and _is_in_warp(ballpark, own_ship_id):
                locked_count = len(_locked_ids(target_service))
                self._set_details('Targeting paused while warping. | Locked: %d' % locked_count)
                return
            locked_count = len(_locked_ids(target_service))
            locking_count = len(_locking_ids(target_service))
            if _available_target_slots(target_service, locked_count, locking_count) <= 0:
                self._set_details('Targeting paused: target slots full. | Locked: %d | Locking: %d' % (locked_count, locking_count))
                return
            max_range = _max_targeting_range(target_service)
            candidates = self._candidate_targets(ballpark, target_service, max_range)
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
