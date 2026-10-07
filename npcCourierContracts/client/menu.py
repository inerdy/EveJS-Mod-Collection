# -*- coding: utf-8 -*-
"""NPC Courier Contracts Hauler Progression and automation window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'NpcCourierHaulerProgressWindow'
_SERVICE = 'npcCourierContracts'
_AUTOMATION_EVENT = 'OnNpcCourierContractsAutomation'
_window = None
_listener = None
_last_route_key = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_XP = '0xffffd166'
_COLOR_BONUS = '0xffd6a4ff'
_COLOR_ERROR = '0xffff6b6b'


def _color(color, text):
    return '<color=%s>%s</color>' % (color, text)


def _value(source, key, default=None):
    if isinstance(source, dict):
        return source.get(key, default)
    return getattr(source, key, default)


def _number(value, default=0.0):
    try:
        if isinstance(value, basestring):
            value = value.strip()
            if not value:
                return default
        return float(value)
    except Exception:
        return default


def _integer(value, default=0):
    return int(_number(value, default))


def _decimal_text(value, places=1):
    rounded = round(_number(value), places)
    return '%s' % rounded


def _set_client_destination(route_target):
    station_id = _integer(_value(route_target, 'destinationStationID', 0), 0)
    system_id = _integer(_value(route_target, 'destinationSolarSystemID', 0), 0)
    if not station_id and not system_id:
        return False

    def try_route_target(target_id, service_names, method_names, clear_other_waypoints):
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
                    method(
                        target_id,
                        clearOtherWaypoints=clear_other_waypoints,
                    )
                    return True
                except TypeError:
                    try:
                        method(target_id, clear_other_waypoints)
                        return True
                    except Exception:
                        try:
                            method(target_id)
                            return True
                        except Exception:
                            continue
                except Exception:
                    continue
        return False

    # Establish the solar-system route first. Some client route services
    # clear the current route before rejecting a station item ID, so this
    # keeps the fallback route intact even when station targeting is not
    # supported by that client build.
    system_set = False
    if system_id:
        system_set = try_route_target(
            system_id,
            ('starmap', 'map', 'autoPilot', 'autopilot'),
            ('SetDestination', 'SetWaypoint', 'AddWaypoint'),
            True,
        )

    # A station waypoint preserves the exact drop-off target when supported.
    # Do not clear the system route while attempting this second step.
    if station_id and try_route_target(
        station_id,
        ('starmap', 'map', 'autoPilot', 'autopilot'),
        ('SetDestination', 'SetWaypoint', 'AddWaypoint'),
        False,
    ):
        return True

    if system_set:
        return True
    if not station_id:
        return False
    return try_route_target(
        station_id,
        ('starmap', 'map', 'autoPilot', 'autopilot'),
        ('SetDestination', 'SetWaypoint'),
        True,
    )


def _route_key(route_target):
    return (
        _integer(_value(route_target, 'contractID', 0), 0),
        _integer(_value(route_target, 'destinationStationID', 0), 0),
        _integer(_value(route_target, 'destinationSolarSystemID', 0), 0),
    )


def _apply_automation_route(route_target, force=False):
    global _last_route_key
    key = _route_key(route_target)
    if not any(key):
        return False
    if not force and key == _last_route_key:
        return True
    applied = _set_client_destination(route_target)
    if applied:
        _last_route_key = key
    return applied


class AutomationListener(object):
    """Receives server-side automation events while the menu is closed."""

    _notify_events = (_AUTOMATION_EVENT, 'OnSessionChanged')

    def __init__(self):
        self._registered = False
        self._registered_events = []
        self._registration_generation = 0
        self._poll_generation = 0
        self._register()

    def _register(self):
        registered_events = []
        try:
            for event in self._notify_events:
                sm.RegisterForNotifyEvent(self, event)
                registered_events.append(event)
            self._registered_events = registered_events
            self._registered = True
            self._start_poll()
            self._refresh_automation()
        except Exception:
            for event in registered_events:
                try:
                    sm.UnregisterForNotifyEvent(self, event)
                except Exception:
                    pass
            self._registration_generation += 1
            uthread.new(self._register_later, self._registration_generation)

    def _register_later(self, generation):
        for _attempt in range(20):
            if generation != self._registration_generation:
                return
            registered_events = []
            try:
                blue.pyos.synchro.SleepWallclock(500)
                for event in self._notify_events:
                    sm.RegisterForNotifyEvent(self, event)
                    registered_events.append(event)
                self._registered_events = registered_events
                self._registered = True
                self._start_poll()
                self._refresh_automation()
                return
            except Exception:
                for event in registered_events:
                    try:
                        sm.UnregisterForNotifyEvent(self, event)
                    except Exception:
                        pass
                continue

    def OnNpcCourierContractsAutomation(self, payload=None, *args):
        global _last_route_key
        payload = payload or {}
        route_target = _value(payload, 'routeTarget', None)
        if _value(payload, 'autoRoute', False):
            if route_target:
                _apply_automation_route(route_target, force=True)
            else:
                _last_route_key = None
        else:
            _last_route_key = None
        if _window is not None and not _window.destroyed:
            _window._apply_automation_event(payload)

    def OnSessionChanged(self, *args):
        global _last_route_key
        _last_route_key = None
        uthread.new(self._refresh_automation)
        if _window is not None and not _window.destroyed:
            uthread.new(_window._load_automation)

    def _start_poll(self):
        self._poll_generation += 1
        uthread.new(self._poll_automation, self._poll_generation)

    def _poll_automation(self, generation):
        while self._registered and generation == self._poll_generation:
            try:
                blue.pyos.synchro.SleepWallclock(5000)
                if not self._registered or generation != self._poll_generation:
                    return
                self._refresh_automation()
            except Exception:
                return

    def _refresh_automation(self):
        global _last_route_key
        try:
            state = sm.RemoteSvc(_SERVICE).GetAutomationState({})
            if isinstance(state, basestring):
                state = json.loads(state)
            if _value(state, 'autoRoute', False):
                route_target = _value(state, 'routeTarget', None)
                if route_target:
                    _apply_automation_route(route_target)
                else:
                    _last_route_key = None
            else:
                _last_route_key = None
            if _window is not None and not _window.destroyed:
                _window._apply_automation_event(state)
        except Exception:
            pass

    def close(self):
        self._registration_generation += 1
        self._poll_generation += 1
        if self._registered:
            for event in self._registered_events:
                try:
                    sm.UnregisterForNotifyEvent(self, event)
                except Exception:
                    pass
        self._registered = False
        self._registered_events = []


class HaulerProgressWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Hauler Progression'
    default_width = 470
    default_height = 500
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._automation_state = {
            'autoRoute': False,
            'autoComplete': False,
            'routeTarget': None,
        }
        self._scroll = ScrollContainer(
            parent=self.content,
            align=uiconst.TOALL,
            padding=(8, 2, 8, 8),
        )
        self._body = Container(
            parent=self._scroll,
            align=uiconst.TOTOP,
            height=530,
        )
        self._summary = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=72,
            padLeft=10,
            padTop=8,
            text=_color(_COLOR_MUTED, 'Loading Hauler progression...'),
        )
        self._progress = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=72,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._stats = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=88,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._recent = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=62,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._automation_status = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=54,
            padLeft=10,
            padTop=4,
            text=_color(_COLOR_MUTED, 'Loading courier automation...'),
        )
        self._route_toggle = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=28,
            padLeft=10,
            padTop=4,
            label='Automatic Routing: DISABLED',
            func=self._toggle_route,
        )
        self._complete_toggle = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=28,
            padLeft=10,
            padTop=4,
            label='Automatic Dock Completion: DISABLED',
            func=self._toggle_completion,
        )
        EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=66,
            padLeft=10,
            padTop=8,
            text=_color(
                _COLOR_MUTED,
                'Automatic routing replaces the current destination with the nearest personal NPC courier drop-off system. ' +
                'Automatic completion only succeeds when the intact contract package is in your ship at the exact station.',
            ),
        )
        self._load()
        uthread.new(self._refresh_loop, self._generation)

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('NPC Courier Contracts returned no state')
        return response

    def _load(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetHaulerProgress({}))
            if not self.destroyed:
                self._render(state)
        except Exception as error:
            if not self.destroyed:
                self._summary.SetText(
                    _color(_COLOR_ERROR, 'Hauler progression unavailable: %s' % error)
                )
        self._load_automation()

    def _load_automation(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetAutomationState({}))
            if not self.destroyed:
                self._set_automation_state(state)
        except Exception as error:
            if not self.destroyed:
                self._automation_status.SetText(
                    _color(_COLOR_ERROR, 'Courier automation unavailable: %s' % error)
                )

    def _refresh_loop(self, generation):
        while not self._closed and generation == self._generation:
            try:
                blue.pyos.synchro.SleepWallclock(5000)
                if self._closed or self.destroyed:
                    break
                self._load()
            except Exception:
                break

    def _set_automation_state(self, state):
        self._automation_state = {
            'autoRoute': _value(state, 'autoRoute', False) is True,
            'autoComplete': _value(state, 'autoComplete', False) is True,
            'routeTarget': _value(state, 'routeTarget', None),
        }
        self._route_toggle.SetLabel(
            'Automatic Routing: %s' % ('ENABLED' if self._automation_state['autoRoute'] else 'DISABLED')
        )
        self._complete_toggle.SetLabel(
            'Automatic Dock Completion: %s' % ('ENABLED' if self._automation_state['autoComplete'] else 'DISABLED')
        )
        target = self._automation_state['routeTarget']
        if target:
            self._automation_status.SetText(
                '%s %s jumps: %s - %s' % (
                    _color(_COLOR_LABEL, 'Nearest NPC courier:'),
                    _color(_COLOR_ACTIVE, _integer(_value(target, 'jumps', 0), 0)),
                    _color(_COLOR_XP, _value(target, 'destinationSolarSystemName', 'Unknown system')),
                    _color(_COLOR_MUTED, _value(target, 'destinationStationName', 'Unknown station')),
                )
            )
        else:
            self._automation_status.SetText(
                _color(_COLOR_MUTED, 'No accepted personal NPC courier contracts found.')
            )

    def _apply_automation_event(self, payload):
        if _value(payload, 'autoRoute', None) is not None:
            self._set_automation_state(payload)
        completed = _value(payload, 'completedContractIDs', []) or []
        failed = _value(payload, 'failedContractIDs', []) or []
        if failed:
            self._automation_status.SetText(
                _color(_COLOR_ERROR, 'Automatic completion deferred; contract cargo is missing or invalid.')
            )
        elif completed:
            self._automation_status.SetText(
                _color(_COLOR_ACTIVE, 'Automatically completed %s NPC courier contract(s).' % len(completed))
            )

    def _update_automation(self, key, enabled):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).SetAutomationSettings({key: enabled}))
            self._set_automation_state(state)
        except Exception as error:
            self._automation_status.SetText(
                _color(_COLOR_ERROR, 'Could not update courier automation: %s' % error)
            )

    def _toggle_route(self, *args):
        self._update_automation('autoRoute', not self._automation_state['autoRoute'])

    def _toggle_completion(self, *args):
        self._update_automation('autoComplete', not self._automation_state['autoComplete'])

    def _render(self, state):
        level = _integer(state.get('level', 1) or 1, 1)
        max_level = _integer(state.get('maxLevel', 50) or 50, 50)
        total_xp = _integer(state.get('totalXP', 0) or 0)
        xp_into = _integer(state.get('xpIntoLevel', 0) or 0)
        xp_next = _integer(state.get('xpForNextLevel', 0) or 0)
        percent = _number(state.get('progressPercent', 0) or 0)
        bonus = _number(state.get('payoutBonusPercent', 0) or 0)
        contracts = _integer(state.get('contractsCompleted', 0) or 0)
        jumps = _integer(state.get('totalJumps', 0) or 0)
        volume = _number(state.get('totalVolumeM3', 0) or 0)
        if level >= max_level:
            progress_text = 'MAX LEVEL - %s total XP' % total_xp
        else:
            progress_text = '%s / %s XP this level | %s%% | %s XP to next' % (
                xp_into,
                xp_into + xp_next,
                _decimal_text(percent),
                xp_next,
            )
        self._summary.SetText(
            '%s %s / %s\n%s %s\n%s %s%%' % (
                _color(_COLOR_LABEL, 'Hauler Level:'),
                _color(_COLOR_ACTIVE, level),
                _color(_COLOR_MUTED, max_level),
                _color(_COLOR_LABEL, 'Total XP:'),
                _color(_COLOR_XP, total_xp),
                _color(_COLOR_LABEL, 'Future payout bonus:'),
                ('+' if bonus >= 0 else '') + _decimal_text(bonus),
            )
        )
        self._progress.SetText(
            '%s\n%s' % (
                _color(_COLOR_LABEL, 'Level Progress'),
                _color(_COLOR_XP, progress_text),
            )
        )
        self._stats.SetText(
            '%s %s\n%s %s\n%s %s m3' % (
                _color(_COLOR_LABEL, 'Contracts completed:'),
                _color(_COLOR_ACTIVE, contracts),
                _color(_COLOR_LABEL, 'Stargate jumps hauled:'),
                _color(_COLOR_ACTIVE, jumps),
                _color(_COLOR_LABEL, 'Cargo delivered:'),
                _color(_COLOR_ACTIVE, _decimal_text(volume)),
            )
        )
        last_award = state.get('lastAward') or {}
        if last_award:
            self._recent.SetText(
                '%s\n%s' % (
                    _color(_COLOR_LABEL, 'Latest completion:'),
                    _color(
                        _COLOR_MUTED,
                        '+%s XP | +%s ISK bonus | Level %s' % (
                            _integer(last_award.get('xp', 0) or 0),
                            _decimal_text(last_award.get('bonusISK', 0) or 0),
                            _integer(last_award.get('levelAfter', level) or level, level),
                        ),
                    ),
                )
            )
        else:
            self._recent.SetText(_color(_COLOR_MUTED, 'Complete an NPC courier contract to begin.'))

    def Close(self, *args, **kwargs):
        global _window
        self._closed = True
        self._generation += 1
        if _window is self:
            _window = None
        return Window.Close(self, *args, **kwargs)


def open_window():
    global _window
    if _window is not None and not _window.destroyed:
        _window.Maximize()
        return
    _window = HaulerProgressWindow.Open()


registration = mods.register(
    'npccouriercontracts',
    {'en': 'Hauler Progression'},
    open_window,
    api_version=1,
)

try:
    _listener = AutomationListener()
except Exception:
    _listener = None


def cleanup():
    global _window, _listener
    registration.close()
    if _listener is not None:
        _listener.close()
        _listener = None
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
