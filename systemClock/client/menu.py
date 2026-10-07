# -*- coding: utf-8 -*-
"""System Clock shared Mods-menu entrypoint."""

import time

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.window import Window
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'SystemClockWindow'
_window = None


class SystemClockWindow(Window):
    """Small native EVE window showing the local computer time."""

    default_windowID = _WINDOW_ID
    default_caption = 'System Clock'
    default_width = 220
    default_height = 100
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._clock_closed = False
        self._clock_generation = 1
        self.time_label = EveLabelMedium(
            parent=self.content,
            align=uiconst.CENTER,
            text='',
        )
        self._update_time()
        uthread.new(self._clock_loop, self._clock_generation)

    def _format_local_time(self):
        value = time.strftime('%I:%M:%S %p', time.localtime())
        if value.startswith('0'):
            value = value[1:]
        return value

    def _update_time(self):
        if self.time_label is not None and not self.destroyed:
            self.time_label.SetText(self._format_local_time())

    def _clock_loop(self, generation):
        while not self._clock_closed and generation == self._clock_generation:
            try:
                self._update_time()
                blue.pyos.synchro.SleepWallclock(1000)
            except Exception:
                break

    def Close(self, *args, **kwargs):
        global _window
        self._clock_closed = True
        self._clock_generation += 1
        if _window is self:
            _window = None
        return Window.Close(self, *args, **kwargs)


def open_window():
    global _window
    if _window is not None and not _window.destroyed:
        _window.Maximize()
        return
    _window = SystemClockWindow.Open()


registration = mods.register(
    'systemclock',
    {'en': 'System Clock'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
