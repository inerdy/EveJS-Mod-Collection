# -*- coding: utf-8 -*-
"""System Discovery Rewards shared Mods-menu window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.window import Window
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'SystemDiscoveryRewardsWindow'
_SERVICE = 'systemDiscoveryRewards'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_XP = '0xffffd166'
_COLOR_SP = '0xff9ee493'
_COLOR_PLEX = '0xffd6a4ff'
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


def _decimal_text(value, places=1):
    rounded = round(_number(value), places)
    return '%s' % rounded


def _format_isk(value):
    return '{:,.0f}'.format(_number(value, 0))


class SystemDiscoveryRewardsWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'System Discovery Rewards'
    default_width = 480
    default_height = 420
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._summary = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=86,
            padLeft=10,
            padTop=8,
            text=_color(_COLOR_MUTED, 'Loading discovery progress...'),
        )
        self._progress = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=74,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._stats = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=104,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._recent = EveLabelMedium(
            parent=self.content,
            align=uiconst.TOTOP,
            height=120,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._load()
        uthread.new(self._refresh_loop, self._generation)

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('System discovery returned no state')
        return response

    def _load(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetDiscoveryProgress({}))
            if not self.destroyed:
                self._render(state)
        except Exception as error:
            if not self.destroyed:
                self._summary.SetText(
                    _color(_COLOR_ERROR, 'Discovery progress unavailable: %s' % error)
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

    def _render(self, state):
        level = _integer(state.get('level', 1) or 1, 1)
        max_level = _integer(state.get('maxLevel', 50) or 50, 50)
        total_xp = _integer(state.get('totalXP', 0) or 0)
        xp_into = _integer(state.get('xpIntoLevel', 0) or 0)
        xp_next = _integer(state.get('xpForNextLevel', 0) or 0)
        percent = _number(state.get('progressPercent', 0) or 0)
        discovered = _integer(state.get('systemsDiscovered', 0) or 0)
        total_isk = state.get('totalISK', 0) or 0
        total_skill_points = _integer(state.get('totalSkillPoints', 0) or 0)
        total_plex = _integer(state.get('totalPlex', 0) or 0)
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
            '%s %s / %s\n%s %s\n%s %s' % (
                _color(_COLOR_LABEL, 'Explorer Level:'),
                _color(_COLOR_ACTIVE, level),
                _color(_COLOR_MUTED, max_level),
                _color(_COLOR_LABEL, 'Total XP:'),
                _color(_COLOR_XP, total_xp),
                _color(_COLOR_LABEL, 'Systems discovered:'),
                _color(_COLOR_ACTIVE, discovered),
            )
        )
        self._progress.SetText(
            '%s\n%s' % (
                _color(_COLOR_LABEL, 'Level Progress'),
                _color(_COLOR_XP, progress_text),
            )
        )
        self._stats.SetText(
            '%s %s ISK\n%s %s SP\n%s %s PLEX' % (
                _color(_COLOR_LABEL, 'Total ISK earned:'),
                _color(_COLOR_ACTIVE, _format_isk(total_isk)),
                _color(_COLOR_LABEL, 'Total skill points earned:'),
                _color(_COLOR_SP, '{:,}'.format(total_skill_points)),
                _color(_COLOR_LABEL, 'Total PLEX earned:'),
                _color(_COLOR_PLEX, total_plex),
            )
        )
        recent = state.get('recentDiscoveries') or []
        if recent:
            lines = [_color(_COLOR_LABEL, 'Recent discoveries:')]
            for entry in recent[:5]:
                name = entry.get('systemName', 'Unknown system')
                reward = entry.get('reward') or {}
                lines.append(
                    '%s: +%s ISK | +%s SP | +%s XP | +%s PLEX' % (
                        name,
                        _format_isk(reward.get('isk', 0) or 0),
                        _integer(reward.get('skillPoints', 0) or 0),
                        _integer(reward.get('xp', 0) or 0),
                        _integer(reward.get('plex', 0) or 0),
                    )
                )
            self._recent.SetText('\n'.join(lines))
        else:
            self._recent.SetText(
                _color(_COLOR_MUTED, 'Enter a new known-space system to begin discovering.')
            )

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
    _window = SystemDiscoveryRewardsWindow.Open()


registration = mods.register(
    'systemdiscoveryrewards',
    {'en': 'System Discovery Rewards'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
