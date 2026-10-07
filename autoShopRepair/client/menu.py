# -*- coding: utf-8 -*-
"""Auto Shop Repair Mods-menu window."""

import json

import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'AutoShopRepairWindow'
_SERVICE = 'autoShopRepair'
_window = None


class AutoShopRepairWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Auto Shop Repair'
    default_width = 380
    default_height = 230
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._enabled = True
        self._scroll = ScrollContainer(
            parent=self.content,
            align=uiconst.TOALL,
            padding=(8, 2, 8, 8),
        )
        self._body = Container(
            parent=self._scroll,
            align=uiconst.TOTOP,
            height=220,
        )
        self._status = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=42,
            padLeft=10,
            padTop=10,
            text='Loading Auto Shop Repair settings...',
        )
        self._toggle = Button(
            parent=self._body,
            align=uiconst.TOTOP,
            height=32,
            padLeft=10,
            padTop=8,
            label='Auto Shop Repair: ENABLED',
            func=self._toggle_enabled,
        )
        EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=55,
            padLeft=10,
            padTop=10,
            text='When enabled, docking at an NPC station repairs your active ship and fitted modules using the station repair price. Structures, drones, cargo, and charges are excluded.',
        )
        uthread.new(self._load_state)

    def _decode_state(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('Auto Shop Repair returned no state')
        return response

    def _load_state(self):
        try:
            state = self._decode_state(sm.RemoteSvc(_SERVICE).GetSettings())
            self._set_enabled(state.get('enabled') is True)
        except Exception as error:
            if not self.destroyed:
                self._status.SetText('Auto Shop Repair unavailable: %s' % error)

    def _set_enabled(self, enabled):
        self._enabled = enabled
        self._toggle.SetLabel('Auto Shop Repair: %s' % ('ENABLED' if enabled else 'DISABLED'))
        self._status.SetText('Automatic station repairs are currently %s.' % ('enabled' if enabled else 'disabled'))

    def _toggle_enabled(self, *args):
        try:
            state = self._decode_state(sm.RemoteSvc(_SERVICE).SetEnabled({'enabled': not self._enabled}))
            self._set_enabled(state.get('enabled') is True)
        except Exception as error:
            self._status.SetText('Could not update Auto Shop Repair: %s' % error)

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
    _window = AutoShopRepairWindow.Open()


registration = mods.register('autoshoprepair', {'en': 'Auto Shop Repair'}, open_window, api_version=1)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
