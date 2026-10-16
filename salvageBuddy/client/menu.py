# -*- coding: utf-8 -*-
"""SalvageBuddy Mods-menu window."""

import json

import blue
import evejs_mod_menu as mods
import uthread
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from carbonui.primitives.containerAutoSize import ContainerAutoSize
from carbonui.primitives.fill import Fill
from eve.client.script.ui.control.eveIcon import Icon
from eve.client.script.ui.control.eveLabel import Label


_WINDOW_ID = 'SalvageBuddyWindow'
_SERVICE = 'salvageBuddy'
_window = None

_COLOR_LABEL = '0xff8fd8ff'
_COLOR_MUTED = '0xffa6adb8'
_COLOR_ACTIVE = '0xff71e6a3'
_COLOR_ERROR = '0xffff6b6b'
_COLOR_FEE = '0xffffd166'


def _text(value):
    return unicode(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def _color(color, text):
    return '<color=%s>%s</color>' % (color, _text(text))


def _integer(value, default=0):
    try:
        return int(float(value))
    except Exception:
        return default


def _format_isk(value):
    return '{:,.0f}'.format(float(value or 0))


def _label(parent, text='', **kwargs):
    kwargs.setdefault('align', uiconst.TOTOP)
    kwargs.setdefault('autoFitToText', True)
    kwargs.setdefault('fontsize', 13)
    kwargs.setdefault('state', uiconst.UI_DISABLED)
    return Label(parent=parent, text=text, **kwargs)


class CompactButton(Button):
    def get_intrinsic_height(self):
        return 28

    def get_intrinsic_width(self):
        return max(76, Button.get_intrinsic_width(self))


class SalvageBuddyWindow(Window):
    default_windowID = _WINDOW_ID
    default_caption = 'SalvageBuddy'
    default_width = 430
    default_height = 330
    default_minSize = (400, 300)
    default_scope = uiconst.SCOPE_INGAME

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._closed = False
        self._generation = 0
        self._serial = 0
        self._busy = False
        self._character = session.charid
        self._active_tab = 'service'
        self._collection_signature = None
        self._collection_buttons = []
        Fill(bgParent=self.content, color=(0.025, 0.04, 0.05, 0.9))
        tabs = Container(parent=self.content, align=uiconst.TOTOP, height=38, padding=(12, 6, 12, 4))
        self._service_tab = CompactButton(parent=tabs, align=uiconst.TOLEFT,
            label='> Service', padRight=6, func=lambda *args: self._select_tab('service'))
        self._ships_tab = CompactButton(parent=tabs, align=uiconst.TOLEFT,
            label='Collection Ship', func=lambda *args: self._select_tab('ships'))
        self._service_actions = Container(parent=self.content, align=uiconst.TOBOTTOM,
            height=44, padding=(12, 8, 12, 8))
        self._request = CompactButton(parent=self._service_actions, align=uiconst.TOLEFT,
            label='Summon', padRight=8, func=self._request_service, state=uiconst.UI_DISABLED)
        self._send_away = CompactButton(parent=self._service_actions, align=uiconst.TOLEFT,
            label='Send Away', func=self._send_service_away, state=uiconst.UI_DISABLED)
        notices = ContainerAutoSize(parent=self.content, align=uiconst.TOBOTTOM, alignMode=uiconst.TOTOP, padding=(12, 2, 12, 4))
        self._status = _label(notices, 'Loading...', color=(0.65, 0.73, 0.77, 1))
        self._service_scroll = ScrollContainer(parent=self.content, align=uiconst.TOALL, padding=(12, 2, 12, 6))
        self._service_body = ContainerAutoSize(parent=self._service_scroll, align=uiconst.TOTOP)
        self._service_title = _label(self._service_body, 'Salvage service', fontsize=17, padBottom=8)
        card = ContainerAutoSize(parent=self._service_body, align=uiconst.TOTOP, padding=(0, 0, 0, 8))
        Fill(bgParent=card, color=(0.05, 0.08, 0.1, 0.9))
        self._progress_text = _label(card, padding=(10, 8, 10, 6))
        track = Container(parent=card, align=uiconst.TOTOP, height=4, padding=(10, 0, 10, 8))
        Fill(bgParent=track, color=(0.15, 0.21, 0.24, 1))
        self._progress = Fill(parent=track, align=uiconst.TOLEFT_PROP, width=0, color=(0.32, 0.84, 0.83, 1))
        self._fee = _label(self._service_body, padBottom=6)
        self._destination = _label(self._service_body, padBottom=6, color=(0.65, 0.73, 0.77, 1))
        self._availability = _label(self._service_body, color=(0.65, 0.73, 0.77, 1))
        self._ships_panel = Container(parent=self.content, align=uiconst.TOALL,
                                      padding=(12, 2, 12, 6), state=uiconst.UI_HIDDEN)
        header = ContainerAutoSize(parent=self._ships_panel, align=uiconst.TOTOP, padBottom=8)
        self._collection_status = _label(header)
        self._collection_footer = Container(parent=self._ships_panel, align=uiconst.TOBOTTOM, height=36)
        self._recall_collection = CompactButton(parent=self._collection_footer, align=uiconst.TOLEFT,
            label='Recall Ship', func=self._recall_collection_ship, state=uiconst.UI_HIDDEN)
        self._clear_collection = CompactButton(parent=self._collection_footer, align=uiconst.TOLEFT,
            label='Clear Selection', func=self._clear_collection_ship, state=uiconst.UI_HIDDEN)
        self._collection_list_scroll = ScrollContainer(parent=self._ships_panel, align=uiconst.TOALL)
        self._collection_options = ContainerAutoSize(parent=self._collection_list_scroll, align=uiconst.TOTOP, padBottom=12)
        uthread.new(self._load)
        uthread.new(self._refresh_loop, self._generation)

    def _valid(self):
        return not self.destroyed and not self._closed and session.charid == self._character

    def _select_tab(self, tab_key):
        if tab_key not in ('service', 'ships'):
            return
        self._active_tab = tab_key
        self._service_scroll.state = uiconst.UI_NORMAL if tab_key == 'service' else uiconst.UI_HIDDEN
        self._service_actions.state = uiconst.UI_NORMAL if tab_key == 'service' else uiconst.UI_HIDDEN
        self._ships_panel.state = uiconst.UI_NORMAL if tab_key == 'ships' else uiconst.UI_HIDDEN
        self._service_tab.SetLabel('> Service' if tab_key == 'service' else 'Service')
        self._ships_tab.SetLabel('> Collection Ship' if tab_key == 'ships' else 'Collection Ship')

    def _decode(self, response):
        if isinstance(response, basestring):
            response = json.loads(response)
        if not isinstance(response, dict):
            raise RuntimeError('SalvageBuddy returned no state')
        return response

    def _load(self):
        if not self._valid() or self._busy:
            return
        self._serial += 1
        serial = self._serial
        try:
            state = self._decode(sm.RemoteSvc(_SERVICE).GetState({}))
            if self._valid() and serial == self._serial:
                self._render(state)
                if self._status.text == 'Loading...':
                    self._status.text = ''
        except Exception as error:
            if self._valid() and serial == self._serial:
                self._status.SetText(_color(_COLOR_ERROR, 'Status unavailable: %s' % error))

    def _refresh_loop(self, generation):
        while self._valid() and generation == self._generation:
            blue.pyos.synchro.SleepWallclock(3000)
            self._load()

    def _is_true(self, value):
        if value is True:
            return True
        if isinstance(value, basestring):
            return value.strip().lower() in ('true', '1', 'yes')
        return False

    def _render(self, state):
        if not self._valid():
            return
        active = self._is_true(state.get('active')) or self._is_true(state.get('canSendAway'))
        cooldown = _integer(state.get('cooldownRemainingSeconds'), 0)
        stage = unicode(state.get('stage') or 'idle').replace('-', ' ').replace('_', ' ').title()
        processed = _integer(state.get('targetsProcessed'), 0)
        found = _integer(state.get('targetsFound'), 0)
        remaining = _integer(state.get('targetsRemaining'), 0)
        self._service_title.text = _color(_COLOR_ACTIVE if active else _COLOR_LABEL,
            stage if active else 'Salvage service')
        self._progress_text.text = ('%s processed / %s discovered\n%s targets remaining' %
            (processed, found, remaining)) if active else 'Wrecks and legal containers\nSalvaged automatically on your grid.'
        self._progress.width = max(0.0, min(1.0, float(processed) / found)) if active and found > 0 else 0
        self._fee.text = '%s ISK per service / %ss cooldown' % (
            _format_isk(state.get('serviceFeeISK', 120000)), _integer(state.get('cooldownSeconds'), 120))
        collection = state.get('collectionShip') or {}
        self._destination.text = ('Loot: %s / station hangar' % _text(collection.get('name', 'Collection ship'))
                                  if collection else 'Loot destination: your active ship')
        can_request = self._is_true(state.get('canRequest'))
        self._request.state = uiconst.UI_NORMAL if can_request and not self._busy else uiconst.UI_DISABLED
        self._request.SetLabel('Summon')
        self._request.hint = 'Service fee: %s ISK.' % _format_isk(state.get('serviceFeeISK', 120000))
        self._send_away.state = uiconst.UI_NORMAL if active and not self._busy else uiconst.UI_DISABLED
        reason = 'Ready to summon.'
        if active:
            reason = 'Service is running. Send Away ends this visit.'
        elif not self._is_true(state.get('enabled')):
            reason = 'The service is disabled on this server.'
        elif self._is_true(state.get('isDocked')):
            reason = 'Undock to summon SalvageBuddy.'
        elif cooldown > 0:
            reason = 'Ready in %ss.' % cooldown
        elif not can_request:
            reason = 'Service unavailable in the current location.'
        self._availability.text = reason
        self._render_collection_ship(state)

    def _render_collection_ship(self, state):
        selected = state.get('collectionShip') or {}
        selected_id = _integer(selected.get('shipID'))
        docked = self._is_true(state.get('isDocked'))
        active = self._is_true(state.get('active'))
        returning = self._is_true(state.get('collectionShipReturning')) or self._is_true(state.get('collectionShipRecallRequested'))
        self._collection_status.text = ('Selected: %s\nLoot returns to its station hangar.' % _text(selected.get('name', 'Ship'))
                                        if selected else 'No collection ship\nLoot goes to your active ship.')
        show_recall = not docked and (self._is_true(state.get('collectionShipInSpace')) or returning)
        can_clear = bool(selected_id and docked and not active)
        self._recall_collection.state = (uiconst.UI_NORMAL if self._is_true(state.get('canRecallCollectionShip')) and not self._busy
                                        else uiconst.UI_DISABLED) if show_recall else uiconst.UI_HIDDEN
        self._recall_collection.SetLabel('Returning...' if returning else 'Recall Ship')
        self._clear_collection.state = uiconst.UI_NORMAL if can_clear and not self._busy else uiconst.UI_HIDDEN
        self._collection_footer.height = 36 if show_recall or can_clear else 0
        ships = state.get('availableCollectionShips') or []
        signature = (tuple((ship.get('shipID'), ship.get('name'), ship.get('typeID'),
                            ship.get('typeName'), ship.get('stationName'),
                            (ship.get('cargo') or {}).get('volume'),
                            (ship.get('cargo') or {}).get('capacity'),
                            (ship.get('cargo') or {}).get('quantity')) for ship in ships),
                     selected_id, docked, active, self._busy)
        if signature == self._collection_signature:
            return
        self._collection_signature = signature
        self._collection_options.Flush()
        self._collection_buttons = []
        message = ''
        if active:
            message = 'End the current service before changing the collection ship.'
        elif selected_id:
            message = 'Clear the current selection to choose another ship.' if docked else 'Dock to change the collection ship.'
        elif not docked:
            message = 'Dock to choose a stored ship as your collection ship.'
        elif not ships:
            message = 'No other ships are stored in this station hangar.'
        if message:
            _label(self._collection_options, message, padding=(0, 4, 0, 8))
            return
        for ship in ships:
            row = Container(parent=self._collection_options, align=uiconst.TOTOP,
                            height=82, padBottom=6)
            Fill(bgParent=row, color=(0.05, 0.08, 0.1, 0.9))
            Icon(parent=row, align=uiconst.TOPLEFT, left=8, top=8, size=32,
                 typeID=_integer(ship.get('typeID')), state=uiconst.UI_DISABLED)
            button = CompactButton(parent=row, align=uiconst.TOPRIGHT, top=8, left=4,
                label='Select', func=self._collection_ship_callback(_integer(ship.get('shipID'))),
                state=uiconst.UI_DISABLED if self._busy else uiconst.UI_NORMAL)
            name = unicode(ship.get('name', 'Ship'))
            type_name = unicode(ship.get('typeName', 'Ship'))
            title_text = '%s / %s' % (type_name, name) if name.lower() != type_name.lower() else name
            title = _label(row, _color(_COLOR_LABEL, title_text), padding=(48, 7, 100, 2))
            location = _label(row, '%s / Station: %s' % (
                _color(_COLOR_ACTIVE, 'DOCKED'), _text(ship.get('stationName') or 'Station hangar')),
                padding=(48, 0, 10, 2), color=(0.65, 0.73, 0.77, 1))
            cargo = ship.get('cargo') or {}
            used = max(0.0, float(cargo.get('volume') or 0))
            capacity = max(0.0, float(cargo.get('capacity') or 0))
            fraction = max(0.0, min(1.0, used / capacity)) if capacity > 0 else 0.0
            cargo_text = (
                'Cargo: %s / %s m3  (%s%%)' % (
                    format(used, ',.1f'), format(capacity, ',.1f'), int(fraction * 100))
                if capacity > 0 else 'Cargo: %s m3' % format(used, ',.1f'))
            cargo_label = _label(row, cargo_text, padding=(48, 0, 10, 7), color=(0.65, 0.73, 0.77, 1))
            cargo_label.hint = '%s items in the cargo hold' % _integer(cargo.get('quantity'))
            track = Container(parent=row, align=uiconst.TOBOTTOM, height=3, padding=(8, 0, 8, 0))
            Fill(bgParent=track, color=(0.15, 0.21, 0.24, 1))
            Fill(parent=track, align=uiconst.TOLEFT_PROP, width=fraction,
                 color=(1, 0.68, 0.31, 1) if fraction >= 0.95 else (0.32, 0.84, 0.83, 1))
            row.height = max(82, title.textheight + location.textheight + cargo_label.textheight + 26)
            button.top = max(8, (row.height - 28) // 2)
            self._collection_buttons.append(button)

    def _collection_ship_callback(self, ship_id):
        return lambda *args: self._action('SetCollectionShip', {'shipID': ship_id}, 'Collection ship selected.')

    def _clear_collection_ship(self, *args):
        self._action('SetCollectionShip', {'shipID': 0}, 'Collection ship selection cleared.')

    def _recall_collection_ship(self, *args):
        self._action('RecallCollectionShip', {}, 'Collection ship recall requested.')

    def _request_service(self, *args):
        self._action('RequestSalvage', {}, 'SalvageBuddy requested.')

    def _send_service_away(self, *args):
        self._action('SendAway', {}, 'SalvageBuddy is leaving.')

    def _action(self, method, payload, message):
        if not self._valid() or self._busy:
            return
        self._busy = True
        self._collection_signature = None
        self._serial += 1
        for button in [self._request, self._send_away, self._recall_collection, self._clear_collection] + self._collection_buttons:
            if button.state != uiconst.UI_HIDDEN:
                button.state = uiconst.UI_DISABLED
        self._status.text = 'Working...'
        uthread.new(self._action_work, method, payload, message)

    def _action_work(self, method, payload, message):
        try:
            if not self._valid():
                return
            state = self._decode(getattr(sm.RemoteSvc(_SERVICE), method)(payload))
            if self._valid():
                self._busy = False
                self._render(state)
                self._status.text = _color(_COLOR_ACTIVE, message)
        except Exception as error:
            if self._valid():
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
