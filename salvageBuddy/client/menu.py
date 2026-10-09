# -*- coding: utf-8 -*-
"""SalvageBuddy Mods-menu window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'SalvageBuddyWindow'
_SERVICE = 'salvageBuddy'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_ERROR = '0xffff6b6b'
_COLOR_FEE = '0xffffd166'


def _color(color, text):
    return '<color=%s>%s</color>' % (color, text)


def _integer(value, default=0):
    try:
        return int(float(value))
    except Exception:
        return default


def _format_isk(value):
    return '{:,.0f}'.format(float(value or 0))


class SalvageBuddyWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'SalvageBuddy'
    default_width = 430
    default_height = 270
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._body = Container(parent=self.content, align=uiconst.TOTOP, height=220, padding=(8, 8, 8, 8))
        self._status = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=105,
            padLeft=10,
            padTop=8,
            text=_color(_COLOR_MUTED, 'Loading SalvageBuddy status...'),
        )
        self._details = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=58,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._request = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=34,
            padLeft=10,
            padTop=8,
            label='Summon SalvageBuddy',
            func=self._request_service,
        )
        self._send_away = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=34,
            padLeft=10,
            padTop=6,
            state=uiconst.UI_HIDDEN,
            label='Send SalvageBuddy Away',
            func=self._send_service_away,
        )
        self._load()
        uthread.new(self._refresh_loop, self._generation)

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('SalvageBuddy returned no state')
        return response

    def _load(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetState({}))
            if not self.destroyed:
                self._render(state)
        except Exception as error:
            if not self.destroyed:
                self._status.SetText(_color(_COLOR_ERROR, 'SalvageBuddy unavailable: %s' % error))

    def _refresh_loop(self, generation):
        while not self._closed and generation == self._generation:
            try:
                blue.pyos.synchro.SleepWallclock(3000)
                if self._closed or self.destroyed:
                    break
                self._load()
            except Exception:
                break

    def _render(self, state):
        active = state.get('active') is True
        cooldown = _integer(state.get('cooldownRemainingSeconds'), 0)
        fee = state.get('serviceFeeISK', 120000)
        stage = state.get('stage', 'idle')
        processed = _integer(state.get('targetsProcessed'), 0)
        found = _integer(state.get('targetsFound'), 0)
        if active:
            self._status.SetText(
                '%s\n%s %s\n%s %s' % (
                    _color(_COLOR_LABEL, 'SalvageBuddy is active.'),
                    _color(_COLOR_LABEL, 'Stage:'), _color(_COLOR_ACTIVE, stage),
                    _color(_COLOR_LABEL, 'Targets:'), _color(_COLOR_ACTIVE, '%s processed / %s found' % (processed, found)),
                )
            )
            self._request.state = uiconst.UI_DISABLED
            self._request.SetLabel('SalvageBuddy: %s' % stage)
            self._send_away.state = uiconst.UI_NORMAL
            self._send_away.SetLabel('Send SalvageBuddy Away')
        else:
            self._status.SetText(
                '%s\n%s %s ISK\n%s' % (
                    _color(_COLOR_LABEL, 'Summon a fitted Noctis salvage service.'),
                    _color(_COLOR_LABEL, 'Service fee:'), _color(_COLOR_FEE, _format_isk(fee)),
                    _color(_COLOR_MUTED, 'Uses Tractor Beams, Salvager II modules, and Salvage Drone II support.'),
                )
            )
            can_request = state.get('canRequest') is True
            self._request.state = uiconst.UI_NORMAL if can_request else uiconst.UI_DISABLED
            self._request.SetLabel(
                'Cooldown: %ss' % cooldown if cooldown > 0 else 'Summon SalvageBuddy'
            )
            self._send_away.state = uiconst.UI_HIDDEN
        self._details.SetText(
            _color(_COLOR_MUTED, 'Only one service can be active at a time.\n') +
            _color(_COLOR_MUTED, 'Eligible wrecks and legal cargo containers are handled automatically.')
        )

    def _request_service(self, *args):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).RequestSalvage({}))
            self._render(state)
        except Exception as error:
            if not self.destroyed:
                self._status.SetText(_color(_COLOR_ERROR, 'SalvageBuddy request failed: %s' % error))
        finally:
            if not self.destroyed:
                self._load()

    def _send_service_away(self, *args):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).SendAway({}))
            self._render(state)
        except Exception as error:
            if not self.destroyed:
                self._status.SetText(_color(_COLOR_ERROR, 'Unable to send SalvageBuddy away: %s' % error))
        finally:
            if not self.destroyed:
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
    _window = SalvageBuddyWindow.Open()


registration = mods.register(
    'salvagebuddy',
    {'en': 'SalvageBuddy'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
