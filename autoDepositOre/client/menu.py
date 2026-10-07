# -*- coding: utf-8 -*-
"""Auto Deposit Ore shared Mods-menu window."""

import json

import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.window import Window
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'AutoDepositOreWindow'
_SERVICE = 'autoDepositOre'
_window = None


class AutoDepositOreWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Auto Deposit Ore'
    default_width = 360
    default_height = 150
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._enabled = True
        self._status = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=42,
            padLeft=10,
            padTop=10,
            text='Loading Auto Deposit Ore settings...',
        )
        self._toggle = Button(
            parent=self.content,
            align=uiconst.TOTOP,
            height=32,
            padLeft=10,
            padTop=8,
            label='Auto Deposit Ore: ENABLED',
            func=self._toggle_enabled,
        )
        EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=42,
            padLeft=10,
            padTop=10,
            text='When enabled, ore, gas, ice, and general mining-hold contents '
                 'are moved to your personal hangar after docking.',
        )
        uthread.new(self._load_state)

    def _decode_state(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('Auto Deposit Ore returned no state')
        return response

    def _load_state(self):
        try:
            state = self._decode_state(sm.RemoteSvc(_SERVICE).GetState())
            self._set_enabled(state.get('enabled') is True)
        except Exception as error:
            if not self.destroyed:
                self._status.SetText('Auto Deposit Ore unavailable: %s' % error)

    def _set_enabled(self, enabled):
        self._enabled = enabled
        label = (
            'Auto Deposit Ore: ENABLED'
            if enabled else
            'Auto Deposit Ore: DISABLED'
        )
        try:
            self._toggle.SetLabel(label)
        except Exception:
            self._toggle.label = label
        self._status.SetText(
            'Automatic mining-hold deposits are currently %s.' % (
                'enabled' if enabled else 'disabled',
            ),
        )

    def _toggle_enabled(self, *args):
        requested = not self._enabled
        try:
            response = sm.RemoteSvc(_SERVICE).SetEnabled({'enabled': requested})
            state = self._decode_state(response)
            self._set_enabled(state.get('enabled') is True)
        except Exception as error:
            self._status.SetText('Could not update Auto Deposit Ore: %s' % error)

    def Close(self, *args, **kwargs):
        global _window
        if _window is self:
            _window = None
        return Window.Close(self, *args, **kwargs)


def open_window():
    global _window
    if _window is not None and not _window.destroyed:
        _window.Maximize()
        return
    _window = AutoDepositOreWindow.Open()


registration = mods.register(
    'autodepositore',
    {'en': 'Auto Deposit Ore'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
