# -*- coding: utf-8 -*-
"""NPC Mining Wing shared Mods-menu window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
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


def _color_text(color, text):
    return '<color=%s>%s</color>' % (color, text)


def _status_color(status):
    normalized = (status or '').lower()
    if normalized in ('following', 'follow'):
        return _COLOR_FOLLOWING
    if normalized in ('mining', 'deployed', 'deployed-elsewhere'):
        return _COLOR_ACTIVE
    if normalized in ('warping', 'approaching', 'approaching station', 'traveling'):
        return _COLOR_MOVING
    if normalized in ('docking', 'docking-with-pilot'):
        return _COLOR_MOVING
    if normalized in ('returning', 'recall'):
        return _COLOR_RETURNING
    if normalized in ('combat defense', 'combat', 'drones returning'):
        return _COLOR_COMBAT
    if normalized in ('holding', 'hold'):
        return _COLOR_HOLDING
    if normalized in ('lost', 'error'):
        return _COLOR_ERROR
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

class NpcMiningWingTab(EveLabelMedium):
    """Clickable tab label for switching between wing and owned ships."""

    def ApplyAttributes(self, attributes):
        self._menu_owner = attributes.owner
        self._tab_key = attributes.tab_key
        EveLabelMedium.ApplyAttributes(self, attributes)
        self.state = uiconst.UI_NORMAL

    def OnClick(self, *args):
        if self._menu_owner is not None and not self._menu_owner.destroyed:
            self._menu_owner._select_tab(self._tab_key)


class NpcMiningWingWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'NPC Mining Wing'
    default_width = 640
    default_height = 500
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._request_generation = 0
        self._state_closed = False
        self._state_generation = 1
        self._active_tab = 'wing'
        self._last_state = None
        self._status = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=68,
            padLeft=8,
            padTop=4,
            text=_color_text(_COLOR_MUTED, 'Loading...'),
        )
        self._roster_title = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=22,
            padLeft=8,
            padTop=2,
            text='%s - %s' % (
                _color_text(_COLOR_LABEL, 'Ship Roster'),
                _color_text(_COLOR_MUTED, 'right-click a ship name for commands'),
            ),
        )
        self._tab_bar = Container(
            parent=self.content,
            align=uiconst.TOTOP,
            height=28,
            padLeft=8,
            padTop=2,
        )
        self._wing_tab = NpcMiningWingTab(
            parent=self._tab_bar,
            align=uiconst.TOLEFT,
            width=170,
            height=24,
            owner=self,
            tab_key='wing',
            text=_color_text(_COLOR_ACTIVE, 'Wing Ships'),
        )
        self._all_tab = NpcMiningWingTab(
            parent=self._tab_bar,
            align=uiconst.TOLEFT,
            width=170,
            height=24,
            owner=self,
            tab_key='all',
            text=_color_text(_COLOR_LABEL, 'All Ships'),
        )
        self._scroll = ScrollContainer(
            parent=self.content,
            align=uiconst.TOALL,
            padding=(8, 2, 8, 8),
        )
        self._body = Container(
            parent=self._scroll,
            align=uiconst.TOTOP,
            height=40,
        )
        self._load_state()
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
        self._request_generation += 1
        generation = self._request_generation
        try:
            state = self._decode_state(sm.RemoteSvc(_service).GetWingState())
            if generation != self._request_generation or self.destroyed:
                return
            self._render_state(state)
        except Exception as error:
            self._status.SetText('NPC Mining Wing unavailable: %s' % error)

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

    def _render_state(self, state):
        self._last_state = state
        runtime_status = state.get('runtimeStatus', 'unknown')
        command = state.get('command', 'hold')
        all_ships = state.get('ships', [])
        wing_ships = [ship for ship in all_ships if (
            ship.get('marked') or ship.get('deployed') or ship.get('returning')
        )]
        available_ships = [ship for ship in all_ships if (
            not ship.get('marked') and
            not ship.get('deployed') and
            not ship.get('returning')
        )]
        marked_count = len([ship for ship in all_ships if ship.get('marked')])
        recall_target = state.get('recallTargetSummary', 'Not set')
        runtime_message = state.get('runtimeMessage', '')
        self._status.SetText(
            '%s %s | %s %s | %s %s\n%s %s\n%s\n%s' % (
                _color_text(_COLOR_LABEL, 'Status:'),
                _color_text(_status_color(runtime_status), runtime_status),
                _color_text(_COLOR_LABEL, 'Command:'),
                _color_text(_command_color(command), command),
                _color_text(_COLOR_LABEL, 'Marked:'),
                _color_text(_COLOR_MARKED, marked_count),
                _color_text(_COLOR_LABEL, 'Recall target:'),
                _color_text(_COLOR_MUTED, recall_target),
                _color_text(_COLOR_MUTED, runtime_message),
                _color_text(
                    _COLOR_COLLECTION,
                    'Collection: %s' % (
                        state.get('collectionShipName') or 'Not assigned',
                    ),
                ),
            )
        )
        self._wing_tab.SetText('%s %s' % (
            _color_text(
                _COLOR_ACTIVE if self._active_tab == 'wing' else _COLOR_LABEL,
                'Wing Ships',
            ),
            _color_text(_COLOR_MUTED, '(%s)' % len(wing_ships)),
        ))
        self._all_tab.SetText('%s %s' % (
            _color_text(
                _COLOR_ACTIVE if self._active_tab == 'all' else _COLOR_LABEL,
                'All Ships',
            ),
            _color_text(_COLOR_MUTED, '(%s)' % len(available_ships)),
        ))
        ships = wing_ships if self._active_tab == 'wing' else available_ships
        for child in list(self._body.children):
            child.Close()
        self._body.height = max(40, len(ships) * 90 + 8)
        for ship in ships:
            ship_status = ship.get('statusLabel') or 'AVAILABLE'
            status_detail = ship.get('statusDetail') or ''
            cargo = ship.get('cargo') or {}
            cargo_volume = float(cargo.get('volume', 0) or 0)
            cargo_capacity = float(cargo.get('capacity', 0) or 0)
            cargo_quantity = cargo.get('quantity', 0) or 0
            cargo_percent = float(cargo.get('percent', 0) or 0)
            deployed_drones = int(ship.get('deployedDroneCount', 0) or 0)
            combat_drones = int(ship.get('deployedCombatDroneCount', 0) or 0)
            mining_drones = int(ship.get('deployedMiningDroneCount', 0) or 0)
            ship_name = _color_text(_COLOR_SHIP, '<u>%s</u>' % (
                ship.get('typeName', 'Ship'),
            ))
            pilot_name = ship.get('pilotName') or ''
            if pilot_name:
                ship_name = '%s %s' % (
                    ship_name,
                    _color_text(_COLOR_ACTIVE, '- %s' % pilot_name),
                )
            label = '%s (%s)\n%s' % (
                ship_name,
                _color_text(_COLOR_MUTED, ship.get('shipID')),
                _color_text(_status_color(ship_status), ship_status),
            )
            if ship.get('collection'):
                label = '%s\n%s' % (
                    _color_text(_COLOR_COLLECTION, 'COLLECTION SHIP'),
                    label,
                )
            if status_detail:
                label = '%s | %s' % (label, _color_text(_COLOR_MUTED, status_detail))
            if cargo_capacity > 0:
                cargo_text = 'Cargo: %.1f/%.1f m3 | %s items | %.1f%%' % (
                    cargo_volume,
                    cargo_capacity,
                    cargo_quantity,
                    cargo_percent,
                )
            else:
                cargo_text = 'Cargo: %.1f m3 | %s items' % (
                    cargo_volume,
                    cargo_quantity,
                )
            label = '%s\n%s' % (
                label,
                _color_text(_COLOR_MUTED, cargo_text),
            )
            if deployed_drones > 0:
                label = '%s\n%s' % (
                    label,
                    _color_text(
                        _COLOR_DRONE,
                        'Drones: %s deployed | Combat: %s | Mining: %s' % (
                            deployed_drones,
                            combat_drones,
                            mining_drones,
                        ),
                    ),
                )
            row = NpcMiningWingShipRow(
                parent=self._body,
                align=uiconst.TOTOP,
                height=88,
                padding=(0, 0, 0, 4),
                owner=self,
                ship=ship,
            )
            NpcMiningWingShipLabel(
                parent=row,
                align=uiconst.TOLEFT,
                width=350,
                height=78,
                state=uiconst.UI_NORMAL,
                owner=self,
                ship=ship,
                text=label,
            )
        if not all_ships:
            EveLabelMedium(
                parent=self._body,
                align=uiconst.TOTOP,
                height=30,
                text=_color_text(_COLOR_MUTED, 'No eligible wing ships are currently available.'),
            )
        elif not ships:
            empty_text = (
                'No marked or deployed wing ships.'
                if self._active_tab == 'wing'
                else 'All owned ships are currently marked or deployed.'
            )
            EveLabelMedium(
                parent=self._body,
                align=uiconst.TOTOP,
                height=30,
                text=_color_text(_COLOR_MUTED, empty_text),
            )

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
        try:
            response = getattr(sm.RemoteSvc(_service), method)(payload)
            self._render_state(self._decode_state(response))
        except Exception as error:
            if not self.destroyed:
                self._status.SetText('Request failed: %s' % error)

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
