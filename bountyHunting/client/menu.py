# -*- coding: utf-8 -*-
"""Bounty Hunting progression window for the EveJS Mods menu."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelMedium


_WINDOW_ID = 'BountyHuntingProgressWindow'
_SERVICE = 'bountyHunting'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_XP = '0xffffd166'
_COLOR_REWARD = '0xffd6a4ff'
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


class BountyHuntingWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Bounty Hunting'
    default_width = 470
    default_height = 500
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._scroll = ScrollContainer(
            parent=self.content,
            align=uiconst.TOALL,
            padding=(8, 2, 8, 8),
        )
        self._body = Container(
            parent=self._scroll,
            align=uiconst.TOTOP,
            height=650,
        )
        self._summary = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=84,
            padLeft=10,
            padTop=8,
            text=_color(_COLOR_MUTED, 'Loading bounty-hunting progress...'),
        )
        self._progress = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=70,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._stats = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=132,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._recent = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=250,
            padLeft=10,
            padTop=4,
            text='',
        )
        self._config = EveLabelMedium(
            parent=self._body,
            align=uiconst.TOTOP,
            height=100,
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
            raise RuntimeError('Bounty Hunting returned no state')
        return response

    def _load(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetBountyProgress({}))
            if not self.destroyed:
                self._render(state)
        except Exception as error:
            if not self.destroyed:
                self._summary.SetText(
                    _color(_COLOR_ERROR, 'Bounty Hunting unavailable: %s' % error)
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
        kills = _integer(state.get('totalKills', 0) or 0)
        kills_by_tier = state.get('killsByTier') or {}
        total_isk = state.get('totalISK', 0) or 0
        total_sp = _integer(state.get('totalSkillPoints', 0) or 0)
        total_plex = _integer(state.get('totalPlex', 0) or 0)
        pending = state.get('pendingReward') or {}
        pending_kills = _integer(pending.get('killCount', 0) or 0)
        pending_isk = pending.get('isk', 0) or 0
        pending_sp = _integer(pending.get('skillPoints', 0) or 0)
        pending_plex = _integer(pending.get('plex', 0) or 0)
        pending_text = (
            'Pending payout: %s kills | %s ISK | %s SP | %s PLEX' % (
                pending_kills,
                _format_isk(pending_isk),
                '{:,}'.format(pending_sp),
                pending_plex,
            )
            if pending_kills > 0 else 'Pending payout: none'
        )

        if level >= max_level:
            progress_text = 'MAX LEVEL - %s total XP' % total_xp
        else:
            progress_text = '%s / %s XP this level | %s%% | %s XP to next' % (
                xp_into,
                xp_into + xp_next,
                round(percent, 1),
                xp_next,
            )

        self._summary.SetText(
            '%s %s / %s\n%s %s\n%s %s' % (
                _color(_COLOR_LABEL, 'Bounty Hunter Level:'),
                _color(_COLOR_ACTIVE, level),
                _color(_COLOR_MUTED, max_level),
                _color(_COLOR_LABEL, 'Total XP:'),
                _color(_COLOR_XP, total_xp),
                _color(_COLOR_LABEL, 'NPC kills:'),
                _color(_COLOR_ACTIVE, kills),
            )
        )
        self._progress.SetText(
            '%s\n%s' % (
                _color(_COLOR_LABEL, 'Level Progress'),
                _color(_COLOR_XP, progress_text),
            )
        )
        self._stats.SetText(
            '%s %s\n%s %s\n%s %s ISK\n%s %s SP\n%s %s PLEX\n%s' % (
                _color(_COLOR_LABEL, 'Low / Standard / Elite / Boss:'),
                _color(_COLOR_ACTIVE, '%s / %s / %s / %s' % (
                    _integer(kills_by_tier.get('low', 0)),
                    _integer(kills_by_tier.get('standard', 0)),
                    _integer(kills_by_tier.get('elite', 0)),
                    _integer(kills_by_tier.get('boss', 0)),
                )),
                _color(_COLOR_LABEL, 'Total rewards:'),
                _color(_COLOR_REWARD, 'tracked below'),
                _color(_COLOR_LABEL, 'ISK earned:'),
                _color(_COLOR_ACTIVE, _format_isk(total_isk)),
                _color(_COLOR_LABEL, 'Skill points earned:'),
                _color(_COLOR_REWARD, '{:,}'.format(total_sp)),
                _color(_COLOR_LABEL, 'PLEX earned:'),
                _color(_COLOR_REWARD, total_plex),
                _color(_COLOR_LABEL, pending_text),
            )
        )

        recent = state.get('recentKills') or []
        if recent:
            lines = [_color(_COLOR_LABEL, 'Recent NPC kills:')]
            for entry in recent[:10]:
                reward = entry.get('reward') or {}
                lines.append(
                    '%s [%s] +%s XP | +%s ISK | +%s SP | +%s PLEX' % (
                        entry.get('npcName', 'Unknown NPC'),
                        entry.get('tierLabel', entry.get('tier', 'Low')),
                        _integer(reward.get('xp', 0) or 0),
                        _format_isk(reward.get('isk', 0) or 0),
                        _integer(reward.get('skillPoints', 0) or 0),
                        _integer(reward.get('plex', 0) or 0),
                    )
                )
            self._recent.SetText('\n'.join(lines))
        else:
            self._recent.SetText(_color(_COLOR_MUTED, 'Destroy a native NPC to begin.'))

        tiers = state.get('rewardTiers') or []
        tier_lines = [_color(_COLOR_LABEL, 'Configured reward tiers:')]
        for tier in tiers:
            tier_lines.append(
                '%s: +%s XP | +%s ISK | +%s SP | +%s PLEX' % (
                    tier.get('label', tier.get('id', 'Tier')),
                    _integer(tier.get('xp', 0) or 0),
                    _format_isk(tier.get('isk', 0) or 0),
                    _integer(tier.get('skillPoints', 0) or 0),
                    '%s-%s' % (
                        _integer(tier.get('plexMinimum', 0) or 0),
                        _integer(tier.get('plexMaximum', 0) or 0),
                    ),
                )
            )
        self._config.SetText('\n'.join(tier_lines))

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
    _window = BountyHuntingWindow.Open()


registration = mods.register(
    'bountyhunting',
    {'en': 'Bounty Hunting'},
    open_window,
    api_version=1,
)


def cleanup():
    global _window
    registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
