"use strict";

const Module = require("node:module");
const path = require("node:path");

const MOD_ID = "apparelCosmetics";
const MOD_VERSION = "0.1.0";
const SERVICE_MANAGER_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}serviceManager.js`;
const CHAT_COMMANDS_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}chat${path.sep}chatCommands.js`;
const PAPER_DOLL_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}character${path.sep}paperDollServerService.js`;
const CHAR_SERVICE_SUFFIX = `${path.sep}server${path.sep}src${path.sep}services${path.sep}character${path.sep}charService.js`;
const INSTALLED = Symbol.for("evejs.apparelCosmetics.loaderInstalled");

function log(message) {
  console.log(`[${MOD_ID}] ${message}`);
}

function install() {
  if (Module._load[INSTALLED]) return;
  const originalLoad = Module._load;
  const caches = new WeakMap();
  let service = null;

  function getService() {
    if (!service) {
      const Service = require(path.join(__dirname, "lib", "apparelCosmeticsService"));
      service = new Service();
    }
    return service;
  }

  function wrapServiceManager(exported) {
    if (caches.has(exported)) return caches.get(exported);
    class ApparelCosmeticsServiceManager extends exported {
      constructor(...args) {
        super(...args);
        if (!this.lookup(MOD_ID)) this.register(getService());
      }
    }
    Object.setPrototypeOf(ApparelCosmeticsServiceManager, exported);
    caches.set(exported, ApparelCosmeticsServiceManager);
    return ApparelCosmeticsServiceManager;
  }

  function wrapChatCommands(exported) {
    if (caches.has(exported)) return caches.get(exported);
    const wrapped = {...exported};
    const original = exported.executeChatCommand;
    wrapped.executeChatCommand = function executeApparelCommand(session, rawMessage, chatHub, options = {}) {
      const text = String(rawMessage || "").trim();
      const match = text.match(/^[/.]apparel(?:\s+(.*))?$/i);
      if (!match) return original.call(this, session, rawMessage, chatHub, options);
      const args = String(match[1] || "").trim().split(/\s+/).filter(Boolean);
      const serviceManager = options.serviceManager;
      const apparelService = serviceManager && serviceManager.lookup(MOD_ID);
      if (!apparelService) return {handled: true, message: "Apparel services are unavailable."};
      let message;
      if (!args.length || args[0].toLowerCase() === "help") {
        message = "Usage: /apparel list | /apparel activate <inventoryItemID>";
      } else if (args[0].toLowerCase() === "list") {
        message = apparelService.listCommand(session);
      } else if (args[0].toLowerCase() === "activate") {
        message = apparelService.activateCommand(session, args[1]).message;
      } else {
        message = "Usage: /apparel list | /apparel activate <inventoryItemID>";
      }
      if (chatHub && typeof chatHub.sendSystemMessage === "function") {
        chatHub.sendSystemMessage(session, message);
      }
      return {handled: true, message};
    };
    caches.set(exported, wrapped);
    return wrapped;
  }

  function wrapPaperDoll(exported) {
    if (caches.has(exported)) return caches.get(exported);
    class ApparelPaperDollService extends exported {
      Handle_GetPaperDollData(args, session) {
        const charID = Number(args && args[0]) || Number(session && (session.charid || session.characterID)) || 0;
        getService().repairSavedAppearance(charID);
        return super.Handle_GetPaperDollData(args, session);
      }

      Handle_GetMyPaperDollData(args, session) {
        const charID = Number(session && (session.charid || session.characterID)) || 0;
        getService().repairSavedAppearance(charID);
        return super.Handle_GetMyPaperDollData(args, session);
      }

      _apparelAllowed(charID, payload) {
        const apparelService = getService();
        const locked = apparelService.validateAppearance(charID, payload);
        if (locked.length > 0) {
          log(`blocked locked apparel for character ${charID}: ${locked.join(",")}`);
          return false;
        }
        return true;
      }

      Handle_UpdateExistingCharacterFull(args, session, kwargs) {
        const charID = Number(args && args[0]) || 0;
        if (!this._apparelAllowed(charID, args && args[1])) return null;
        return super.Handle_UpdateExistingCharacterFull(args, session, kwargs);
      }

      Handle_UpdateExistingCharacterLimited(args, session, kwargs) {
        const charID = Number(args && args[0]) || 0;
        if (!this._apparelAllowed(charID, args && args[1])) return null;
        return super.Handle_UpdateExistingCharacterLimited(args, session, kwargs);
      }
    }
    Object.setPrototypeOf(ApparelPaperDollService, exported);
    caches.set(exported, ApparelPaperDollService);
    return ApparelPaperDollService;
  }

  function wrapCharService(exported) {
    if (caches.has(exported)) return caches.get(exported);
    class ApparelCharService extends exported {
      Handle_CreateCharacterWithDoll(args, session, kwargs) {
        const ccSvcWrapper = args && args.length >= 8 &&
          args[5] && typeof args[5] === "object" &&
          args[6] && typeof args[6] === "object";
        const charInfo = args && args[ccSvcWrapper ? 5 : 4];
        if (getService().validateAppearance(0, charInfo).length > 0) return null;
        return super.Handle_CreateCharacterWithDoll(args, session, kwargs);
      }
    }
    Object.setPrototypeOf(ApparelCharService, exported);
    caches.set(exported, ApparelCharService);
    return ApparelCharService;
  }

  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const exported = originalLoad.call(this, request, parent, isMain);
    const filename = String(resolved);
    if (filename.endsWith(SERVICE_MANAGER_SUFFIX)) return wrapServiceManager(exported);
    if (filename.endsWith(CHAT_COMMANDS_SUFFIX)) return wrapChatCommands(exported);
    if (filename.endsWith(PAPER_DOLL_SUFFIX)) return wrapPaperDoll(exported);
    if (filename.endsWith(CHAR_SERVICE_SUFFIX)) return wrapCharService(exported);
    return exported;
  };
  Module._load[INSTALLED] = true;
}

install();
log(`v${MOD_VERSION} active — apparel entitlement enforcement enabled`);

module.exports = Object.freeze({active: true, id: MOD_ID, version: MOD_VERSION});
