# -*- coding: utf-8 -*-
"""Ship Warp Fuel and Odometer Mods-menu window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.combo import Combo
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from carbonui.primitives.containerAutoSize import ContainerAutoSize
from carbonui.primitives.fill import Fill
from eve.client.script.ui.control.eveLabel import Label


_WINDOW_ID = 'ShipWarpFuelWindow'
_SERVICE = 'shipWarpFuel'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_FUEL = '0xffffd166'
_COLOR_DEBT = '0xffff8c8c'
_COLOR_ERROR = '0xffff6b6b'


def _text(value):
    return unicode(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def _color(color, text):
    return '<color=%s>%s</color>' % (color, _text(text))


def _label(parent, text='', **kwargs):
    kwargs.setdefault('align', uiconst.TOTOP)
    kwargs.setdefault('autoFitToText', True)
    kwargs.setdefault('fontsize', 13)
    kwargs.setdefault('state', uiconst.UI_DISABLED)
    return Label(parent=parent, text=text, **kwargs)


def _section(parent, title):
    panel = ContainerAutoSize(parent=parent, align=uiconst.TOTOP, padBottom=12)
    Fill(bgParent=panel, color=(0.05, 0.08, 0.1, 0.9))
    _label(panel, title, fontsize=12, color=(0.45, 0.77, 0.8, 1), padding=(10, 8, 10, 6))
    return panel


class CompactButton(Button):
    def get_intrinsic_height(self):
        return 28

    def get_intrinsic_width(self):
        return max(100, Button.get_intrinsic_width(self))


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


def _format_isk(value):
    return '{:,.0f}'.format(_number(value, 0))


def _route_entry_id(entry):
    integer_types = (int, long)
    if isinstance(entry, integer_types):
        return int(entry) if int(entry) > 0 else None
    for key in ('solarSystemID', 'systemID', 'solarsystemid2', 'solarSystemId'):
        if isinstance(entry, dict):
            value = _integer(entry.get(key), 0)
        else:
            value = _integer(getattr(entry, key, 0), 0)
        if value > 0:
            return value
    return None


def _route_ids(value):
    if isinstance(value, dict):
        for key in ('path', 'route', 'systems', 'systemIDs', 'solarSystems'):
            if key in value:
                route_ids = _route_ids(value.get(key))
                if route_ids:
                    return route_ids
        entry_id = _route_entry_id(value)
        return [entry_id] if entry_id else []
    for key in ('path', 'route', 'systems', 'systemIDs', 'solarSystems'):
        candidate = getattr(value, key, None)
        if candidate is not None:
            route_ids = _route_ids(candidate)
            if route_ids:
                return route_ids
    entry_id = _route_entry_id(value)
    if entry_id:
        return [entry_id]
    if isinstance(value, (list, tuple)):
        result = []
        for entry in value:
            entry_id = _route_entry_id(entry)
            if entry_id:
                result.append(entry_id)
            else:
                result.extend(_route_ids(entry))
        return result
    return []


class ShipWarpFuelWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Ship Warp Fuel'
    default_width = 470
    default_height = 500
    default_minSize = (430, 420)
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._serial = 0
        self._busy = False
        self._loading = False
        self._character = session.charid
        self._display_ship = None
        self._fuel_options = None
        Fill(bgParent=self.content, color=(0.025, 0.04, 0.05, 0.9))
        header = ContainerAutoSize(parent=self.content, align=uiconst.TOTOP, padding=(12, 8, 12, 10))
        self._ship = _label(header, 'Loading ship...', fontsize=16, padBottom=6)
        self._fuel = _label(header, padBottom=6)
        track = Container(parent=header, align=uiconst.TOTOP, height=6, padBottom=6)
        Fill(bgParent=track, color=(0.15, 0.21, 0.24, 1))
        self._gauge = Fill(parent=track, align=uiconst.TOLEFT_PROP, width=0, color=(0.32, 0.84, 0.83, 1))
        self._range = _label(header, color=(0.65, 0.73, 0.77, 1))
        footer = ContainerAutoSize(parent=self.content, align=uiconst.TOBOTTOM,
                                  alignMode=uiconst.TOTOP, padding=(12, 4, 12, 6))
        self._status = _label(footer, '', color=(0.65, 0.73, 0.77, 1))
        self._scroll = ScrollContainer(parent=self.content, align=uiconst.TOALL, padding=(12, 0, 12, 6))
        self._body = ContainerAutoSize(parent=self._scroll, align=uiconst.TOTOP)
        journey = _section(self._body, 'ROUTE & ODOMETER')
        self._waypoint = _label(journey, padding=(10, 0, 10, 6))
        self._odometer = _label(journey, padding=(10, 0, 10, 8), color=(0.65, 0.73, 0.77, 1))
        fuel = _section(self._body, 'FUEL BAY')
        self._fuel_type = Combo(parent=fuel, align=uiconst.TOTOP, padding=(10, 0, 10, 6),
            options=[('Loading fuel types...', 0)], select=0, callback=self._select_fuel_type,
            state=uiconst.UI_DISABLED)
        self._bay = _label(fuel, padding=(10, 0, 10, 6))
        actions = Container(parent=fuel, align=uiconst.TOTOP, height=36, padding=(10, 0, 10, 8))
        self._load_button = CompactButton(parent=actions, align=uiconst.TOLEFT, padRight=8,
            label='Load from Cargo', func=self._load_from_cargo, state=uiconst.UI_DISABLED)
        self._unload_button = CompactButton(parent=actions, align=uiconst.TOLEFT,
            label='Move to Cargo', func=self._unload_to_cargo, state=uiconst.UI_DISABLED)
        self._emergency_panel = _section(self._body, 'EMERGENCY SERVICE')
        self._details = _label(self._emergency_panel, padding=(10, 0, 10, 6))
        emergency_actions = Container(parent=self._emergency_panel, align=uiconst.TOTOP,
                                      height=36, padding=(10, 0, 10, 8))
        self._emergency = CompactButton(parent=emergency_actions, align=uiconst.TOLEFT,
            label='Request Emergency Fuel', func=self._request_emergency, state=uiconst.UI_DISABLED)
        self._emergency_panel.state = uiconst.UI_HIDDEN
        uthread.new(self._load)
        uthread.new(self._refresh_loop, self._generation)

    def _valid(self):
        return not self.destroyed and not self._closed and session.charid == self._character

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('Ship Warp Fuel returned no state')
        return response

    def _load(self):
        if not self._valid() or self._busy:
            return
        self._serial += 1
        serial, ship = self._serial, session.shipid
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetState({}))
            if not self._valid() or serial != self._serial or ship != session.shipid:
                return
            bay = self._decode(sm.RemoteSvc(_SERVICE).GetFuelBayState({}))
            if not self._valid() or serial != self._serial or ship != session.shipid:
                return
            estimate = self._waypoint_estimate()
            if self._valid() and serial == self._serial and ship == session.shipid:
                self._display_ship = ship
                self._render(state, bay, estimate)
        except Exception as error:
            if self._valid() and serial == self._serial:
                self._status.text = _color(_COLOR_ERROR, 'Status unavailable: %s' % error)

    def _refresh_loop(self, generation):
        while self._valid() and generation == self._generation:
            blue.pyos.synchro.SleepWallclock(5000)
            self._load()

    def _waypoint_estimate(self):
        try:
            current_system = _integer(getattr(session, 'solarsystemid2', 0), 0)
            route = None
            for service_name in ('starmap', 'route', 'map', 'autopilot', 'autoPilot'):
                try:
                    route_service = sm.GetService(service_name)
                except Exception:
                    continue
                for method_name in (
                    'GetDestinationPath',
                    'GetAutopilotRoute',
                    'GetCurrentRoute',
                    'GetRoute',
                    'GetPathToDestination',
                    'GetDestination',
                ):
                    method = getattr(route_service, method_name, None)
                    if not callable(method):
                        continue
                    try:
                        candidate = _route_ids(method())
                    except Exception:
                        try:
                            candidate = _route_ids(method(current_system))
                        except Exception:
                            continue
                    if candidate:
                        route = candidate
                        break
                if route:
                    break
            if not route:
                return None
            if current_system in route:
                route = route[route.index(current_system):]
                jumps = max(0, len(route) - 1)
            else:
                jumps = len(route)
            return self._decode(sm.RemoteSvc(_SERVICE).GetWaypointFuelEstimate({
                'hasRoute': True,
                'jumps': jumps,
            }))
        except Exception:
            return None

    def _select_fuel_type(self, control, caption, value):
        # Native combo callbacks can run in a later tasklet, after LoadOptions.
        if not self._loading and self._fuel_options and _integer(value) != self._fuel_options[1]:
            self._action('SetFuelType', {'fuelTypeID': _integer(value)}, 'Fuel type updated.')

    def _render(self, state, bay=None, estimate=None):
        if not self._valid():
            return
        fuel = _integer(state.get('fuelUnits'))
        capacity = _integer(state.get('fuelCapacityUnits'))
        fuel_name = state.get('fuelName', 'Selected isotopes')
        fraction = max(0.0, min(1.0, float(fuel) / capacity)) if capacity > 0 else 0
        self._ship.text = '%s / %s' % (_text(state.get('shipName', 'Current Ship')),
                                      'Enabled' if state.get('enabled') else 'Disabled')
        self._fuel.text = '%s / %s units  (%s%%) / %s' % (
            format(fuel, ','), format(capacity, ','), int(fraction * 100), _text(fuel_name))
        self._gauge.width = fraction
        self._gauge.color = ((1, 0.32, 0.36, 1) if fuel <= 0 else
                            (1, 0.68, 0.31, 1) if fraction <= .2 else (0.32, 0.84, 0.83, 1))
        self._range.text = '%s AU estimated range / %sx burn' % (
            format(_number(state.get('rangeAU')), ',.2f'), format(_number(state.get('fuelMultiplier'), 1), '.2f'))
        self._odometer.text = 'Lifetime: %s AU / %s warps' % (
            format(_number(state.get('totalWarpAU')), ',.3f'), format(_integer(state.get('warpCount')), ','))
        if estimate and estimate.get('hasRoute'):
            required = _integer(estimate.get('fuelRequired'))
            after = _integer(estimate.get('fuelAfterRoute'), _integer(estimate.get('fuelAvailable'), fuel) - required)
            result = '%s units after route' % format(after, ',') if after >= 0 else '%s units short' % format(-after, ',')
            self._waypoint.text = '%s jumps / ~%s AU\n%s units required / %s' % (
                _integer(estimate.get('jumps')), format(_number(estimate.get('estimatedWarpAU')), ',.1f'),
                format(required, ','), _color(_COLOR_ACTIVE if after >= 0 else _COLOR_ERROR, result))
        else:
            self._waypoint.text = 'Set a route to see estimated fuel needs.'
        self._waypoint.hint = 'Estimate based on gate jumps; actual warp distances can differ.'
        bay = bay or {}
        cargo = _integer(bay.get('cargoFuelUnits'))
        self._bay.text = '%s units of %s in cargo' % (format(cargo, ','), _text(fuel_name))
        options = [(unicode(entry.get('name', 'Fuel')) + ' (%sx burn)' % entry.get('burnMultiplier', 1),
                    _integer(entry.get('typeID'))) for entry in state.get('fuelTypes', [])]
        selected = _integer(state.get('fuelTypeID'))
        if selected not in [value for label, value in options]:
            options.append((unicode(fuel_name), selected))
        signature = (options, selected)
        self._loading = True
        try:
            if signature != self._fuel_options or self._fuel_type.GetValue() != selected:
                self._fuel_type.LoadOptions(options, select=selected)
                self._fuel_options = signature
        finally:
            self._loading = False
        self._fuel_type.state = uiconst.UI_NORMAL if len(options) > 1 and not self._busy else uiconst.UI_DISABLED
        self._load_button.state = uiconst.UI_NORMAL if cargo > 0 and fuel < capacity and not self._busy else uiconst.UI_DISABLED
        self._load_button.hint = 'Load selected fuel up to bay capacity.' if cargo > 0 else 'No selected fuel in cargo.'
        self._unload_button.state = uiconst.UI_NORMAL if fuel > 0 and not self._busy else uiconst.UI_DISABLED
        self._unload_button.hint = 'Move selected fuel into available cargo space.'
        in_space = state.get('inSpace') is True
        cooldown = _integer(state.get('emergencyCooldownSeconds'))
        debt = _number(state.get('debtISK'))
        show_emergency = fuel <= 0 and in_space
        self._emergency_panel.state = uiconst.UI_NORMAL if show_emergency or debt > 0 else uiconst.UI_HIDDEN
        self._emergency.state = (uiconst.UI_NORMAL if cooldown <= 0 and not self._busy else uiconst.UI_DISABLED) if show_emergency else uiconst.UI_HIDDEN
        self._emergency.SetLabel('Ready in %ss' % cooldown if cooldown > 0 else 'Request Emergency Fuel')
        self._details.text = 'Outstanding debt: %s ISK' % _format_isk(debt)
        if show_emergency:
            self._details.text += '\nDelivers %s %s for %s ISK.' % (
                _integer(state.get('emergencyFuelUnits'), 25), _text(fuel_name),
                _format_isk(state.get('emergencyFeeISK', 1000000)))

    def _request_emergency(self, *args):
        self._action('RequestEmergencyFuel', {}, 'Emergency fuel request completed.')

    def _load_from_cargo(self, *args):
        self._action('LoadFuel', {'quantity': 0}, 'Fuel loaded into bay.')

    def _unload_to_cargo(self, *args):
        self._action('UnloadFuel', {'quantity': 0}, 'Fuel moved into cargo.')

    def _action(self, method, payload, message):
        if not self._valid() or self._busy:
            return
        if self._display_ship != session.shipid:
            self._status.text = 'Ship changed. Refreshing fuel information...'
            uthread.new(self._load)
            return
        self._busy = True
        self._serial += 1
        for control in (self._fuel_type, self._load_button, self._unload_button, self._emergency):
            if control.state != uiconst.UI_HIDDEN:
                control.state = uiconst.UI_DISABLED
        self._status.text = 'Emergency fuel ship: on the way' if method == 'RequestEmergencyFuel' else 'Working...'
        uthread.new(self._action_work, method, payload, message, session.shipid)

    def _action_work(self, method, payload, message, ship):
        try:
            if not self._valid() or ship != session.shipid:
                return
            result = self._decode(getattr(sm.RemoteSvc(_SERVICE), method)(payload))
            if self._valid() and ship == session.shipid:
                if method in ('LoadFuel', 'UnloadFuel'):
                    message = '%s units %s.' % (_integer(result.get('moved')),
                        'loaded into bay' if method == 'LoadFuel' else 'moved to cargo')
                self._status.text = _color(_COLOR_ACTIVE, message)
        except Exception as error:
            if self._valid() and ship == session.shipid:
                self._status.text = _color(_COLOR_ERROR, 'Request failed: %s' % error)
        finally:
            self._busy = False
            if self._valid():
                self._load()

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
    _window = ShipWarpFuelWindow.Open()


registration = mods.register(
    'shipwarpfuel',
    {'en': 'Ship Warp Fuel'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
