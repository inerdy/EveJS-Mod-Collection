# -*- coding: utf-8 -*-
"""Ship Warp Fuel and Odometer Mods-menu window."""

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


_WINDOW_ID = 'ShipWarpFuelWindow'
_SERVICE = 'shipWarpFuel'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_FUEL = '0xffffd166'
_COLOR_DEBT = '0xffff8c8c'
_COLOR_ERROR = '0xffff6b6b'


def _color(color, text):
    return '<color=%s>%s</color>' % (color, text)


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


class ShipWarpFuelWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Ship Warp Fuel'
    default_width = 470
    default_height = 500
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._emergency_request_pending = False
        self._scroll = ScrollContainer(
            parent=self.content,
            align=uiconst.TOALL,
            padding=(8, 2, 8, 8),
        )
        self._body = Container(
            parent=self._scroll,
            align=uiconst.TOTOP,
            height=520,
        )
        self._status = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=68,
            padLeft=10,
            padTop=8,
            text=_color(_COLOR_MUTED, 'Loading warp fuel status...'),
        )
        self._fuel = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=58,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._bay = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=30,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._odometer = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=58,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._load_button = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=30,
            padLeft=10,
            padTop=4,
            label='Load Oxygen from Cargo',
            func=self._load_from_cargo,
        )
        self._unload_button = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=30,
            padLeft=10,
            padTop=4,
            label='Move Oxygen to Cargo',
            func=self._unload_to_cargo,
        )
        self._emergency = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=32,
            padLeft=10,
            padTop=8,
            state=uiconst.UI_HIDDEN,
            label='Request Emergency Fuel',
            func=self._request_emergency,
        )
        self._details = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=70,
            padLeft=10,
            padTop=8,
            state=uiconst.UI_HIDDEN,
            text='',
        )
        self._load()
        uthread.new(self._refresh_loop, self._generation)

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('Ship Warp Fuel returned no state')
        return response

    def _load(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetState({}))
            bay = self._decode(sm.RemoteSvc(_SERVICE).GetFuelBayState({}))
            if not self.destroyed:
                self._render(state, bay)
        except Exception as error:
            if not self.destroyed:
                self._status.SetText(_color(_COLOR_ERROR, 'Warp fuel unavailable: %s' % error))

    def _refresh_loop(self, generation):
        while not self._closed and generation == self._generation:
            try:
                blue.pyos.synchro.SleepWallclock(5000)
                if self._closed or self.destroyed:
                    break
                self._load()
            except Exception:
                break

    def _render(self, state, bay=None):
        fuel = _integer(state.get('fuelUnits', 0), 0)
        capacity = _integer(state.get('fuelCapacityUnits', 0), 0)
        range_au = _number(state.get('rangeAU', 0), 0)
        cooldown = _integer(state.get('emergencyCooldownSeconds', 0), 0)
        debt = state.get('debtISK', 0) or 0
        self._status.SetText(
            '%s %s\n%s %s' % (
                _color(_COLOR_LABEL, 'Ship:'),
                _color(_COLOR_ACTIVE, state.get('shipName', 'Current Ship')),
                _color(_COLOR_LABEL, 'Warp fuel system:'),
                _color(_COLOR_ACTIVE, 'ENABLED' if state.get('enabled') else 'DISABLED'),
            )
        )
        self._fuel.SetText(
            '%s %s / %s Oxygen Isotopes\n%s %s AU estimated range' % (
                _color(_COLOR_LABEL, 'Fuel:'),
                _color(_COLOR_FUEL, '{:,}'.format(fuel)),
                _color(_COLOR_MUTED, '{:,}'.format(capacity)),
                _color(_COLOR_LABEL, 'Range:'),
                _color(_COLOR_FUEL, '{:,.2f}'.format(range_au)),
            )
        )
        bay = bay or {}
        self._bay.SetText(
            '%s %s / %s units' % (
                _color(_COLOR_LABEL, 'Fuel Bay:'),
                _color(_COLOR_FUEL, '{:,}'.format(_integer(bay.get('fuelUnits', fuel), fuel))),
                _color(_COLOR_MUTED, '{:,}'.format(_integer(bay.get('fuelCapacityUnits', capacity), capacity))),
            )
        )
        self._odometer.SetText(
            '%s %s AU\n%s %s warp(s)' % (
                _color(_COLOR_LABEL, 'Ship odometer:'),
                _color(_COLOR_ACTIVE, '{:,.3f}'.format(_number(state.get('totalWarpAU', 0), 0))),
                _color(_COLOR_LABEL, 'Warp count:'),
                _color(_COLOR_ACTIVE, '{:,}'.format(_integer(state.get('warpCount', 0), 0))),
            )
        )
        if self._emergency_request_pending:
            self._emergency.SetLabel('Emergency fuel ship: on the way')
        else:
            self._emergency.SetLabel(
                'Emergency Fuel: %ss cooldown' % cooldown
                if cooldown > 0 else
                'Request Emergency Fuel'
            )
        if fuel <= 0:
            self._emergency.state = (
                uiconst.UI_DISABLED
                if self._emergency_request_pending
                else uiconst.UI_NORMAL
            )
        else:
            self._emergency.state = uiconst.UI_HIDDEN
        self._details.state = uiconst.UI_NORMAL if fuel <= 0 else uiconst.UI_HIDDEN
        self._details.SetText(
            '%s %s ISK\n%s' % (
                _color(_COLOR_LABEL, 'Emergency fuel debt:'),
                _color(_COLOR_DEBT if _number(debt, 0) > 0 else _COLOR_ACTIVE, _format_isk(debt)),
                _color(_COLOR_MUTED, 'Emergency service delivers 25 Oxygen Isotopes and charges 1,000,000 ISK.'),
            )
        )

    def _request_emergency(self, *args):
        if self._emergency_request_pending:
            return
        self._emergency_request_pending = True
        error_text = None
        self._emergency.state = uiconst.UI_DISABLED
        self._emergency.SetLabel('Emergency fuel ship: on the way')
        self._status.SetText(_color(_COLOR_ACTIVE, 'Emergency fuel ship is on the way.'))
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).RequestEmergencyFuel({}))
            self._render(state)
        except Exception as error:
            error_text = _color(_COLOR_ERROR, 'Emergency fuel unavailable: %s' % error)
            self._status.SetText(error_text)
        finally:
            self._emergency_request_pending = False
            if not self.destroyed:
                self._load()
                if error_text is not None:
                    self._status.SetText(error_text)

    def _load_from_cargo(self, *args):
        try:
            response = self._decode(sm.RemoteSvc(_SERVICE).LoadFuel({'quantity': 0}))
            self._status.SetText(_color(_COLOR_ACTIVE, 'Loaded %s Oxygen Isotopes into the fuel bay.' % _integer(response.get('moved', 0), 0)))
            self._load()
        except Exception as error:
            self._status.SetText(_color(_COLOR_ERROR, 'Fuel bay loading failed: %s' % error))

    def _unload_to_cargo(self, *args):
        try:
            response = self._decode(sm.RemoteSvc(_SERVICE).UnloadFuel({'quantity': 0}))
            self._status.SetText(_color(_COLOR_ACTIVE, 'Moved %s Oxygen Isotopes into cargo.' % _integer(response.get('moved', 0), 0)))
            self._load()
        except Exception as error:
            self._status.SetText(_color(_COLOR_ERROR, 'Fuel bay unloading failed: %s' % error))

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
