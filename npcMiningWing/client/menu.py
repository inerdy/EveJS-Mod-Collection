# -*- coding: utf-8 -*-
"""NPC Mining Wing shared Mods-menu window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from carbonui.primitives.containerAutoSize import ContainerAutoSize
from carbonui.primitives.fill import Fill
from eve.client.script.ui.control.eveIcon import Icon
from eve.client.script.ui.control.eveLabel import Label
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'NpcMiningWingWindow'
_service = 'npcMiningWing'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_SHIP = '0xff4ca3ff'
_COLOR_MARKED = '0xffffd166'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_MOVING = '0xffffb86c'
_COLOR_FOLLOWING = '0xff73cfff'
_COLOR_HOLDING = '0xffd6a4ff'
_COLOR_RETURNING = '0xffff8c8c'
_COLOR_ERROR = '0xffff6b6b'
_COLOR_COMBAT = '0xffff7f9f'
_COLOR_DRONE = '0xffb8a1ff'
_COLOR_COLLECTION = '0xffffc857'
_ACCENT = (0.32, 0.84, 0.83, 1.0)


def _text(value):
    return unicode(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def _color_text(color, text):
    return '<color=%s>%s</color>' % (color, text)


def _label(parent, text='', **kwargs):
    kwargs.setdefault('align', uiconst.TOTOP)
    kwargs.setdefault('autoFitToText', True)
    kwargs.setdefault('fontsize', 13)
    kwargs.setdefault('state', uiconst.UI_DISABLED)
    return Label(parent=parent, text=text, **kwargs)


class CompactButton(Button):
    def get_intrinsic_height(self):
        return 28

    def get_intrinsic_width(self):
        return max(76, Button.get_intrinsic_width(self))


def _human_error(code):
    raw = str(code or '').strip()
    marker = raw.find('NPC_WING_')
    if marker >= 0:
        raw = raw[marker:]
    parts = raw.split(':', 1)
    message = parts[0].replace('NPC_WING_', '').replace('_', ' ').title()
    detail = parts[1].strip() if len(parts) > 1 else ''
    return '%s (%s)' % (message, detail) if detail else message


def _status_color(status):
    normalized = (status or '').lower()
    if normalized in ('following', 'follow'):
        return _COLOR_FOLLOWING
    if normalized in ('mining', 'deployed', 'deployed-elsewhere'):
        return _COLOR_ACTIVE
    if normalized in ('launching', 'warping', 'approaching', 'approaching station', 'traveling'):
        return _COLOR_MOVING
    if normalized in ('docking', 'docking-with-pilot'):
        return _COLOR_MOVING
    if normalized in ('returning', 'recall', 'hold full'):
        return _COLOR_RETURNING
    if normalized in ('combat defense', 'combat', 'drones returning'):
        return _COLOR_COMBAT
    if normalized in ('collection waiting', 'lost', 'error'):
        return _COLOR_ERROR
    if normalized in ('holding', 'hold'):
        return _COLOR_HOLDING
    if normalized in ('marked', 'roster-ready'):
        return _COLOR_MARKED
    return _COLOR_MUTED


def _command_color(command):
    normalized = (command or '').lower()
    if normalized in ('follow', 'following'):
        return _COLOR_FOLLOWING
    if normalized in ('mine', 'mining', 'deploy', 'deployed'):
        return _COLOR_ACTIVE
    if normalized in ('hold', 'holding'):
        return _COLOR_HOLDING
    if normalized in ('recall', 'returning'):
        return _COLOR_RETURNING
    return _COLOR_LABEL


class NpcMiningWingShipRow(Container):
    """Roster row that exposes a native EVE right-click menu."""

    def ApplyAttributes(self, attributes):
        self._menu_owner = attributes.owner
        self._ship = attributes.ship
        Container.ApplyAttributes(self, attributes)

    def GetMenu(self):
        if self._menu_owner is None or self._menu_owner.destroyed:
            return []
        return self._menu_owner._get_ship_menu(self._ship)

class NpcMiningWingShipLabel(EveLabelMedium):
    """Interactive ship text so EVE can route right-click menus to it."""

    def ApplyAttributes(self, attributes):
        self._menu_owner = attributes.owner
        self._ship = attributes.ship
        EveLabelMedium.ApplyAttributes(self, attributes)

    def GetMenu(self):
        if self._menu_owner is None or self._menu_owner.destroyed:
            return []
        return self._menu_owner._get_ship_menu(self._ship)

class NpcMiningWingWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'NPC Mining Wing'
    default_width = 640
    default_height = 500
    default_minSize = (560, 400)
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._request_generation = 0
        self._state_closed = False
        self._state_generation = 1
        self._active_tab = 'wing'
        self._last_state = None
        self._pending_requests = {}
        self._rows = {}
        self._roster_key = None
        self._character = session.charid
        Fill(bgParent=self.content, color=(0.025, 0.04, 0.05, 0.9))
        self._header = ContainerAutoSize(parent=self.content, align=uiconst.TOTOP,
                                        padding=(12, 8, 12, 8))
        self._summary = _label(self._header, 'Connecting to wing...', fontsize=16)
        self._destination = _label(self._header, padTop=5, color=(0.65, 0.73, 0.77, 1))
        self._runtime = _label(self._header, padTop=4, color=(0.65, 0.73, 0.77, 1))
        self._diagnostics = _label(self._header, padTop=4, state=uiconst.UI_HIDDEN)
        footer = Container(parent=self.content, align=uiconst.TOBOTTOM, height=44,
                           padding=(12, 8, 12, 8))
        self._commands = {}
        for command, caption in (('deploy', 'Deploy Wing'), ('follow', 'Follow'),
                                 ('mine', 'Mine'), ('hold', 'Hold'), ('recall', 'Recall Wing')):
            self._commands[command] = CompactButton(parent=footer, align=uiconst.TOLEFT,
                padRight=6, label=caption, func=self._command_callback(command),
                state=uiconst.UI_DISABLED, hint='Applies to the entire wing.')
        notices = ContainerAutoSize(parent=self.content, align=uiconst.TOBOTTOM,
                                    alignMode=uiconst.TOTOP, padding=(12, 2, 12, 4))
        self._status = _label(notices, color=(0.65, 0.73, 0.77, 1))
        self._tab_bar = Container(parent=self.content, align=uiconst.TOTOP,
                                  height=34, padding=(12, 0, 12, 4))
        self._wing_tab = CompactButton(parent=self._tab_bar, align=uiconst.TOLEFT,
            padRight=6, label='Wing Ships', func=lambda *args: self._select_tab('wing'))
        self._all_tab = CompactButton(parent=self._tab_bar, align=uiconst.TOLEFT,
            label='Available Ships', func=lambda *args: self._select_tab('all'))
        CompactButton(parent=self._tab_bar, align=uiconst.TORIGHT,
            label='Details', func=self._toggle_details, hint='Show runtime diagnostics.')
        self._scroll = ScrollContainer(parent=self.content, align=uiconst.TOALL,
                                       padding=(12, 0, 12, 8))
        self._body = ContainerAutoSize(parent=self._scroll, align=uiconst.TOTOP)
        self._roster = ContainerAutoSize(parent=self._body, align=uiconst.TOTOP)
        uthread.new(self._load_state)
        uthread.new(self._ensure_wing_chat)
        uthread.new(self._state_loop, self._state_generation)

    def _state_loop(self, generation):
        while not self._state_closed and generation == self._state_generation:
            try:
                blue.pyos.synchro.SleepWallclock(1000)
                if self._state_closed or self.destroyed:
                    break
                self._load_state()
            except Exception:
                break

    def _load_state(self):
        if self.destroyed or session.charid != self._character or self._pending_requests:
            return
        self._request_generation += 1
        generation = self._request_generation
        try:
            state = self._decode_state(sm.RemoteSvc(_service).GetWingState())
            if generation != self._request_generation or self.destroyed:
                return
            self._render_state(state)
        except Exception as error:
            if not self.destroyed and session.charid == self._character:
                self._status.SetText('NPC Mining Wing unavailable: %s' % _text(error))

    def _decode_state(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('NPC Mining Wing returned no state')
        return response

    def _ensure_wing_chat(self):
        try:
            response = sm.RemoteSvc(_service).EnsureWingChat({})
            if isinstance(response, basestring):
                response = json.loads(response)
            if not isinstance(response, dict):
                raise RuntimeError('NPC Mining Wing returned no chat channel')
            room_name = response.get('roomName') or ''
            channel_id = response.get('channelID') or 0
            if self._join_wing_chat_client(room_name, channel_id):
                return
            self._status.SetText(
                'Wing Comms ready. Open the channel link in Local chat or use the chat + menu.'
            )
        except Exception as error:
            if not self.destroyed:
                self._status.SetText('Wing Comms unavailable: %s' % error)

    def _join_wing_chat_client(self, room_name, channel_id):
        if not room_name:
            return False
        service_names = ('XmppChat', 'chat')
        method_names = ('JoinChannel', 'OpenChatChannel', 'OpenChannel', 'JoinRoom')
        values = [room_name, 'joinChannel:%s' % room_name]
        if channel_id:
            values.append(channel_id)
        for service_name in service_names:
            try:
                service = sm.GetService(service_name)
            except Exception:
                continue
            for method_name in method_names:
                method = getattr(service, method_name, None)
                if method is None:
                    continue
                for value in values:
                    try:
                        result = method(value)
                        if result is not False:
                            return True
                    except TypeError:
                        continue
                    except Exception:
                        break
        return False

    def _toggle_details(self, *args):
        self._diagnostics.state = (uiconst.UI_DISABLED if
            self._diagnostics.state == uiconst.UI_HIDDEN else uiconst.UI_HIDDEN)

    def _render_state(self, state):
        if self.destroyed or session.charid != self._character:
            return
        self._last_state = state
        all_ships = state.get('ships', [])
        wing = [ship for ship in all_ships if ship.get('marked') or
                ship.get('deployed') or ship.get('returning')]
        available = [ship for ship in all_ships if ship not in wing]
        status = state.get('runtimeStatus', 'unknown')
        command = state.get('command', 'hold')
        self._summary.text = '%s  /  %s  /  %s ships' % (
            _color_text(_status_color(status), _text(status).title()),
            _color_text(_command_color(command), _text(command).title()), len(wing))
        self._destination.text = 'Recall: %s\nCollection: %s' % (
            _text(state.get('recallTargetSummary') or 'Not set'),
            _text(state.get('collectionShipName') or 'Not assigned'))
        trip = state.get('collectionTrip') or {}
        message = state.get('runtimeMessage') or 'Right-click a ship name for commands.'
        if trip.get('lastError'):
            message = 'Collection retry: %s' % _human_error(trip['lastError'])
        self._runtime.text = _text(message)
        metrics = state.get('runtimeMetrics') or {}
        self._diagnostics.text = 'Ticks: %s | Cycles: %s | Cargo moves: %s | Failures: %s' % (
            metrics.get('runtimeTicks', 0), metrics.get('miningActivations', 0),
            metrics.get('cargoMoves', 0), metrics.get('runtimeFailures', 0))
        self._wing_tab.SetLabel('%sWing Ships (%s)' % ('> ' if self._active_tab == 'wing' else '', len(wing)))
        self._all_tab.SetLabel('%sAvailable (%s)' % ('> ' if self._active_tab == 'all' else '', len(available)))
        deployed = any(ship.get('deployed') for ship in wing)
        for key, button in self._commands.items():
            enabled = any(ship.get('marked') and not ship.get('deployed') and
                          not ship.get('returning') for ship in wing) if key == 'deploy' else deployed
            button.state = uiconst.UI_NORMAL if enabled and not self._pending_requests else uiconst.UI_DISABLED
        ships = wing if self._active_tab == 'wing' else available
        key = (self._active_tab, tuple(ship.get('shipID') for ship in ships))
        # Preserve widgets and scroll position while telemetry changes.
        if key != self._roster_key:
            self._roster_key = key
            self._roster.Flush()
            self._rows = {}
            for ship in ships:
                row = NpcMiningWingShipRow(parent=self._roster, align=uiconst.TOTOP,
                    height=110, padBottom=6, owner=self, ship=ship, state=uiconst.UI_NORMAL)
                Fill(bgParent=row, color=(0.05, 0.08, 0.1, 0.9), state=uiconst.UI_DISABLED)
                Icon(parent=row, align=uiconst.TOPLEFT, left=8, top=8, size=32,
                     typeID=ship.get('typeID'), state=uiconst.UI_DISABLED)
                row.title = NpcMiningWingShipLabel(parent=row, align=uiconst.TOTOP,
                    padding=(48, 8, 10, 3), autoFitToText=True, owner=self, ship=ship,
                    text='', state=uiconst.UI_NORMAL)
                row.status = _label(row, padding=(48, 0, 10, 3))
                row.cargo = _label(row, padding=(48, 0, 10, 3))
                row.drones = _label(row, padding=(48, 0, 10, 6))
                track = Container(parent=row, align=uiconst.TOBOTTOM, height=3, padding=(8, 0, 8, 0))
                Fill(bgParent=track, color=(0.15, 0.21, 0.24, 1))
                row.bar = Fill(parent=track, align=uiconst.TOLEFT_PROP, width=0, color=_ACCENT)
                self._rows[ship.get('shipID')] = row
            if not ships:
                _label(self._roster, 'No ships in the wing. Open Available to mark ships.' if
                       self._active_tab == 'wing' else 'No available ships at this time.', padding=12)
        for ship in ships:
            row = self._rows[ship.get('shipID')]
            row._ship = row.title._ship = ship
            title = _text(ship.get('typeName', 'Ship'))
            if ship.get('pilotName'):
                title += ' / ' + _text(ship['pilotName'])
            row.title.SetText(_color_text(_COLOR_SHIP, '<u>%s</u>' % title))
            row.title.hint = 'Ship %s. Right-click for commands.' % ship.get('shipID')
            status = ship.get('statusLabel') or 'AVAILABLE'
            detail = ship.get('statusDetail') or ''
            row.status.text = '%s%s%s' % (
                'COLLECTION SHIP / ' if ship.get('collection') else '',
                _color_text(_status_color(status), _text(status)),
                ' / ' + _text(detail) if detail else '')
            cargo = ship.get('cargo') or {}
            used = float(cargo.get('volume') or 0)
            capacity = float(cargo.get('capacity') or 0)
            fraction = max(0.0, min(1.0, used / capacity)) if capacity > 0 else 0
            row.bar.width = fraction
            row.bar.color = (1, 0.68, 0.31, 1) if fraction >= 0.95 else _ACCENT
            row.cargo.text = ('Cargo: %s / %s m3  (%s%%)' % (
                format(used, ',.1f'), format(capacity, ',.1f'), int(fraction * 100))) if capacity > 0 else 'Cargo: %s m3' % format(used, ',.1f')
            row.cargo.hint = '%s items' % cargo.get('quantity', 0)
            row.drones.text = _color_text(_COLOR_DRONE, 'Drones: %s mining / %s combat / %s deployed' % (
                ship.get('deployedMiningDroneCount', 0), ship.get('deployedCombatDroneCount', 0),
                ship.get('deployedDroneCount', 0)))
            # Native measured text handles long ship names and narrow windows.
            row.height = max(110, sum(label.textheight for label in
                (row.title, row.status, row.cargo, row.drones)) + 36)

    def _select_tab(self, tab_key):
        if tab_key not in ('wing', 'all') or self._active_tab == tab_key:
            return
        self._active_tab = tab_key
        if self._last_state is not None:
            self._render_state(self._last_state)

    def _get_ship_menu(self, ship):
        """Build the menu for one roster row.

        Follow, Hold, Mine, and Recall are currently wing-level service
        commands. Mark, Find, and Collect Cargo use the selected ship.
        """
        menu = []
        ship_id = ship.get('shipID')
        if not ship.get('deployed') and not ship.get('returning'):
            menu.append((
                'Unmark Ship' if ship.get('marked') else 'Mark Ship',
                self._mark_callback(ship_id, not ship.get('marked')),
            ))
        if ship.get('deployed') or ship.get('returning'):
            menu.append(('Find Ship', self._find_callback(ship)))
            if ship.get('collection'):
                menu.append((
                    'Send Collection Ship to Station',
                    self._collection_trip_callback(),
                ))
                menu.append((
                    'Clear Collection Ship Role',
                    self._collection_callback(ship, False),
                ))
            else:
                menu.append((
                    'Set as Collection Ship',
                    self._collection_callback(ship, True),
                ))
            menu.append((
                'Collect Cargo from Ship',
                self._collect_callback(ship),
            ))
            menu.append((None, None))
            menu.extend((
                ('Follow Wing', self._command_callback('follow')),
                ('Hold Wing', self._command_callback('hold')),
                ('Mine Wing', self._command_callback('mine')),
                ('Recall Wing', self._command_callback('recall')),
            ))
        elif ship.get('marked'):
            menu.append((
                'Clear Collection Ship Role' if ship.get('collection')
                else 'Set as Collection Ship',
                self._collection_callback(ship, not ship.get('collection')),
            ))
            menu.append(('Deploy Wing', self._command_callback('deploy')))
        return menu

    def _command_callback(self, command):
        return lambda *args: self._set_command(command)

    def _mark_callback(self, ship_id, marked):
        return lambda *args: self._set_marked(ship_id, marked)

    def _find_callback(self, ship):
        return lambda *args: self._find_ship(ship)

    def _collect_callback(self, ship):
        return lambda *args: self._collect_ship(ship)

    def _collection_callback(self, ship, enabled):
        return lambda *args: self._set_collection_ship(ship, enabled)

    def _collection_trip_callback(self):
        return lambda *args: self._send_collection_ship()

    def _set_marked(self, ship_id, marked):
        uthread.new(self._request, 'SetShipMarked', {'shipID': ship_id, 'marked': marked})

    def _collect_ship(self, ship):
        uthread.new(
            self._request,
            'TransferCargo',
            {'shipID': ship.get('shipID')},
        )

    def _set_collection_ship(self, ship, enabled):
        uthread.new(
            self._request,
            'SetCollectionShip',
            {'shipID': ship.get('shipID'), 'enabled': enabled},
        )

    def _send_collection_ship(self):
        uthread.new(self._request, 'SendCollectionShip', {})

    def _set_command(self, command):
        if command == 'deploy':
            uthread.new(self._request, 'DeployWing', {})
        elif command == 'recall':
            uthread.new(self._request, 'RecallWing', {})
        elif command == 'collect':
            uthread.new(self._request, 'TransferCargo', {})
        else:
            uthread.new(self._request, 'SetWingCommand', {'command': command})

    def _find_ship(self, ship):
        system_id = ship.get('deployedSystemID')
        if not system_id:
            self._status.SetText('Find failed: ship location is unknown.')
            return
        service_names = ('starmap', 'map', 'autopilot')
        method_names = ('SetDestination', 'SetWaypoint', 'AddWaypoint')
        for service_name in service_names:
            try:
                service = sm.GetService(service_name)
            except Exception:
                continue
            for method_name in method_names:
                method = getattr(service, method_name, None)
                if method is None:
                    continue
                try:
                    method(system_id)
                    self._status.SetText(
                        'Destination set to %s for %s.' % (
                            ship.get('deployedSystemName') or system_id,
                            ship.get('typeName', 'ship'),
                        )
                    )
                    return
                except TypeError:
                    try:
                        method(system_id, clearOtherWaypoints=True)
                        self._status.SetText(
                            'Destination set to %s for %s.' % (
                                ship.get('deployedSystemName') or system_id,
                                ship.get('typeName', 'ship'),
                            )
                        )
                        return
                    except Exception:
                        continue
                except Exception:
                    continue
        self._status.SetText(
            'Find failed: the client route service could not set %s.' % (
                ship.get('deployedSystemName') or system_id,
            )
        )

    def _request(self, method, payload):
        if self.destroyed or session.charid != self._character or self._pending_requests:
            return
        self._request_generation += 1
        self._pending_requests[method] = True
        for button in self._commands.values():
            button.state = uiconst.UI_DISABLED
        try:
            response = getattr(sm.RemoteSvc(_service), method)(payload)
            if not self.destroyed:
                self._render_state(self._decode_state(response))
                if session.charid == self._character:
                    self._status.text = "Request accepted."
        except Exception as error:
            if not self.destroyed:
                self._status.SetText('Request failed: %s' % _human_error(error))
        finally:
            self._pending_requests.pop(method, None)
            if not self.destroyed:
                uthread.new(self._load_state)

    def Close(self, *args, **kwargs):
        global _window
        self._state_closed = True
        self._state_generation += 1
        if _window is self:
            _window = None
        return Window.Close(self, *args, **kwargs)


def open_window():
    global _window
    if _window is not None and not _window.destroyed:
        _window.Maximize()
        return
    _window = NpcMiningWingWindow.Open()


registration = mods.register(
    'npcminingwing',
    {'en': 'NPC Mining Wing'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
