# -*- coding: utf-8 -*-
"""Live server health dashboard for the EveJS Mods menu."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from carbonui.primitives.containerAutoSize import ContainerAutoSize
from carbonui.primitives.fill import Fill
from eve.client.script.ui.control.eveLabel import Label


_WINDOW_ID = 'ServerHealthMonitorWindow'
_SERVICE = 'serverHealthMonitor'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_HEALTHY = '0xff71e6a3'
_COLOR_DEGRADED = '0xffffd166'
_COLOR_STALLED = '0xffff6b6b'
_COLOR_TRANSITION = '0xff8fd8ff'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_VALUE = '0xffffffff'
_GM_ROLE_MASK = (
    274877906944 |       # GMS
    9007199254740992 |   # GMH
    18014398509481984 |  # GML
    72057594037927936    # Admin
)


def _color(color, text):
    return '<color=%s>%s</color>' % (color, text)


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


def _format_count(value):
    if value is None:
        return '-'
    return str(_integer(value, 0))


def _format_ms(value):
    if value is None:
        return '-'
    value = _number(value, 0)
    if value >= 1000:
        return '%.2f s' % (value / 1000.0)
    return '%.0f ms' % value


def _format_duration(value):
    if value is None:
        return '-'
    seconds = max(0, int(_number(value, 0) / 1000.0))
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return '%dh %02dm %02ds' % (hours, minutes, seconds)
    if minutes:
        return '%dm %02ds' % (minutes, seconds)
    return '%ds' % seconds


def _status_color(status):
    return {
        'healthy': _COLOR_HEALTHY,
        'degraded': _COLOR_DEGRADED,
        'stalled': _COLOR_STALLED,
        'transition': _COLOR_TRANSITION,
    }.get(status, _COLOR_MUTED)


def _bar(value, maximum, width=24):
    value = max(0.0, _number(value, 0))
    maximum = max(value, _number(maximum, 0))
    if maximum <= 0:
        return '.' * width
    filled = min(width, int(round((value / maximum) * width)))
    return '#' * filled + '.' * (width - filled)


def _client_is_gm():
    try:
        role = int(
            getattr(session, 'accountRole', 0) or
            getattr(session, 'role', 0) or
            getattr(session, 'rolesAtAll', 0) or
            0
        )
        return (role & _GM_ROLE_MASK) != 0
    except Exception:
        return False


class ServerHealthMonitorWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'Server Health Monitor'
    default_width = 520
    default_height = 500
    default_minSize = (470, 420)
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        Fill(bgParent=self.content, color=(0.025, 0.04, 0.05, 0.9))
        header = ContainerAutoSize(parent=self.content, align=uiconst.TOTOP, padding=(12, 8, 12, 10))
        self._hero = _label(header, 'SERVER HEALTH', fontsize=16, padBottom=5)
        self._hero_meta = _label(header, 'Loading live telemetry...', color=(0.65, 0.73, 0.77, 1), padBottom=8)
        track = Container(parent=header, align=uiconst.TOTOP, height=6, padBottom=2)
        Fill(bgParent=track, color=(0.15, 0.21, 0.24, 1))
        self._gauge = Fill(parent=track, align=uiconst.TOLEFT_PROP, width=0, color=(0.32, 0.84, 0.83, 1))
        footer = ContainerAutoSize(parent=self.content, align=uiconst.TOBOTTOM,
                                  alignMode=uiconst.TOTOP, padding=(12, 4, 12, 6))
        self._status = _label(footer, 'GM diagnostics available  |  Refreshes every 2 seconds',
                              color=(0.65, 0.73, 0.77, 1))
        self._scroll = ScrollContainer(parent=self.content, align=uiconst.TOALL, padding=(12, 0, 12, 6))
        self._body = ContainerAutoSize(parent=self._scroll, align=uiconst.TOTOP)
        live = _section(self._body, 'LIVE SERVER STATUS')
        self._summary = _label(live, 'Loading server health...', padding=(10, 0, 10, 8))
        performance = _section(self._body, 'PERFORMANCE')
        self._performance = _label(performance, '', padding=(10, 0, 10, 8))
        heartbeat = _section(self._body, 'HEARTBEAT')
        self._heartbeat = _label(heartbeat, '', padding=(10, 0, 10, 8))
        history = _section(self._body, 'RECENT HEALTH SAMPLES')
        self._history = _label(history, '', padding=(10, 0, 10, 8))
        diagnostics = _section(self._body, 'SCENE DIAGNOSTICS')
        self._scene_diagnostics = _label(diagnostics, _color(_COLOR_MUTED, 'Loading scene diagnostics...'),
                                         padding=(10, 0, 10, 8))
        self._load()
        uthread.new(self._refresh_loop, self._generation)

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('Server Health Monitor returned no state')
        return response

    def _load(self):
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetHealthStatus({}))
            if not self.destroyed:
                self._render(state)
                self._render_scene_diagnostics(state)
                self._status.text = 'GM diagnostics available  |  Refreshes every 2 seconds'
        except Exception as error:
            if not self.destroyed:
                self._status.text = _color(_COLOR_STALLED, 'Server Health Monitor unavailable: %s' % error)

    def _refresh_loop(self, generation):
        while not self._closed and generation == self._generation:
            try:
                blue.pyos.synchro.SleepWallclock(2000)
                if self._closed or self.destroyed:
                    break
                self._load()
            except Exception:
                break

    def _render(self, state):
        status = str(state.get('status', 'healthy')).lower()
        current = state.get('current') or {}
        performance = state.get('performance') or {}
        heartbeat = state.get('heartbeat') or {}
        thresholds = state.get('thresholds') or {}
        status_text = status.upper()
        transition = state.get('transition') or {}
        transition_text = ''
        if transition.get('active'):
            transition_text = ' (%s)' % str(transition.get('kind', 'transition')).replace('-', ' ')
        event_loop_delay = _number(current.get('eventLoopDelayMs'), 0)
        stalled_limit = _number(thresholds.get('stalledEventLoopDelayMs'), 0)
        self._hero.text = _color(_status_color(status), status_text + transition_text)
        self._hero_meta.text = 'Current lag %s  |  Event-loop delay %s' % (
            _format_ms(current.get('currentLagMs')),
            _format_ms(current.get('eventLoopDelayMs')))
        self._gauge.width = min(1.0, event_loop_delay / stalled_limit) if stalled_limit > 0 else 0
        self._gauge.color = {
            'healthy': (0.32, 0.84, 0.83, 1),
            'degraded': (1, 0.68, 0.31, 1),
            'stalled': (1, 0.32, 0.36, 1),
            'transition': (0.32, 0.7, 1, 1),
        }.get(status, (0.55, 0.62, 0.65, 1))
        self._summary.text = '%s\n%s' % (
            _color(_COLOR_LABEL, 'Systems loaded: %s | Ticking: %s | Active sessions: %s' % (
                _format_count(current.get('sceneCount')),
                _format_count(current.get('tickedSceneCount')),
                _format_count(current.get('sessions')),
            )),
            _color(_COLOR_VALUE, 'Tick duration: %s | Tick lateness: %s' % (
                _format_ms(current.get('tickDurationMs')),
                _format_ms(current.get('tickLatenessMs')),
            )),
        )
        self._performance.text = (
            '%s\n%s\n%s\n%s\n%s\n%s' % (
                _color(_COLOR_LABEL, 'Peak lag:'),
                _color(_COLOR_VALUE, _format_ms(performance.get('peakLagMs'))),
                _color(_COLOR_LABEL, 'Average / worst tick:'),
                _color(_COLOR_VALUE, '%s / %s' % (
                    _format_ms(performance.get('averageTickDurationMs')),
                    _format_ms(performance.get('worstTickDurationMs')),
                )),
                _color(_COLOR_LABEL, 'Average / worst event-loop delay:'),
                _color(_COLOR_VALUE, '%s / %s' % (
                    _format_ms(performance.get('averageEventLoopDelayMs')),
                    _format_ms(performance.get('worstEventLoopDelayMs')),
                )),
            )
        )
        self._performance.text += '\n%s\n%s' % (
            _color(_COLOR_LABEL, 'CPU / memory RSS:'),
            _color(_COLOR_VALUE, '%s%% / %s MB' % (
                _format_count(current.get('cpuPercent')),
                _format_count(current.get('memoryRssMb')),
            )),
        )
        self._heartbeat.text = (
            '%s\n%s\n%s' % (
                _color(_COLOR_LABEL, 'Time since last healthy heartbeat:'),
                _color(_COLOR_VALUE, _format_duration(heartbeat.get('timeSinceHealthyMs'))),
                _color(_COLOR_MUTED, 'Thresholds: degraded %s | stalled %s' % (
                    _format_ms(thresholds.get('degradedEventLoopDelayMs')),
                    _format_ms(thresholds.get('stalledEventLoopDelayMs')),
                )),
            )
        )

        history = state.get('history') or []
        if not history:
            self._history.text = _color(_COLOR_MUTED, 'Waiting for health samples...')
        else:
            maximum_lag = max([_number(entry.get('currentLagMs', 0)) for entry in history] or [0])
            lines = [_color(_COLOR_MUTED, 'Latest %s samples  |  bars show relative current lag' % min(30, len(history)))]
            for entry in history[-30:]:
                entry_status = str(entry.get('status', 'healthy')).lower()
                timestamp = str(entry.get('timestamp', ''))
                if 'T' in timestamp:
                    timestamp = timestamp.split('T', 1)[1].split('.', 1)[0]
                line = '%s  %s  loop %s  |  tick %s' % (
                    timestamp,
                    _bar(entry.get('currentLagMs', 0), maximum_lag, width=12),
                    _format_ms(entry.get('eventLoopDelayMs')),
                    _format_ms(entry.get('tickDurationMs')),
                )
                lines.append(_color(_status_color(entry_status), line))
            self._history.text = '\n'.join(lines)

    def _render_scene_diagnostics(self, state):
        current = state.get('current') or {}
        scenes = current.get('sceneDiagnostics') or []
        lines = [
            _color(_COLOR_MUTED, 'GM-only live counts from loaded solar-system scenes.'),
        ]
        if not scenes:
            lines.append(_color(_COLOR_MUTED, 'No loaded scene diagnostics are available.'))
            self._scene_diagnostics.text = '\n'.join(lines)
            return
        lines.append(_color(_COLOR_LABEL, 'Loaded scenes: %s' % len(scenes)))
        for scene in scenes:
            lines.append('')
            lines.append(_color(_COLOR_ACTIVE, '%s (%s)' % (
                scene.get('systemName', 'Unknown system'),
                _format_count(scene.get('systemID')),
            )))
            lines.append(_color(_COLOR_VALUE, 'Sessions: %s | Entities: %s (%s static / %s dynamic)' % (
                _format_count(scene.get('sessions')),
                _format_count(scene.get('totalEntities')),
                _format_count(scene.get('staticEntities')),
                _format_count(scene.get('dynamicEntities')),
            )))
            lines.append(_color(_COLOR_VALUE, 'NPCs: %s | Ships: %s | Drones: %s' % (
                _format_count(scene.get('npcCount')),
                _format_count(scene.get('shipCount')),
                _format_count(scene.get('droneCount')),
            )))
            lines.append(_color(_COLOR_VALUE, 'Wrecks: %s | Containers: %s' % (
                _format_count(scene.get('wreckCount')),
                _format_count(scene.get('containerCount')),
            )))
        self._scene_diagnostics.text = '\n'.join(lines)

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
    _window = ServerHealthMonitorWindow.Open()


registration = None
if _client_is_gm():
    registration = mods.register(
        'serverhealthmonitor',
        {'en': 'Server Health Monitor'},
        open_window,
        api_version=1,
    )


def cleanup():
    global _window
    if registration is not None:
        registration.close()
    if _window is not None and not _window.destroyed:
        _window.Close()
    _window = None
