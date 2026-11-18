// ==UserScript==
// @name         Mail Hub 邮箱助手
// @name:en      Mail Hub Assistant
// @namespace    https://github.com/ydddp/mail-hub/userscript
// @version      0.13.2
// @description  用你自己的 Mail Hub 临时邮箱收取验证码，手动上报成功并关闭。
// @description:en  Get a disposable inbox from your own Mail Hub on signup pages, fill in the address and code, then report and close.
// @author       ydddp
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_registerMenuCommand
// @connect      *
// @updateURL    https://raw.githubusercontent.com/ydddp/mail-hub/userscript/mail-hub.user.js
// @downloadURL  https://raw.githubusercontent.com/ydddp/mail-hub/userscript/mail-hub.user.js
// @supportURL   https://github.com/ydddp/mail-hub/issues
// ==/UserScript==

"use strict";
(() => {
  // userscript/src/i18n.ts
  var zh = {
    // capsule
    "cap.connectTitle": "连接你的 Mail Hub",
    "cap.notConnected": "还没连接",
    "cap.noInbox": "还没有邮箱",
    "cap.unknownSite": "认不出当前网站",
    "cap.needService": "先填写服务标识",
    "cap.getting": "正在获取邮箱…",
    "cap.createUnknown": "获取结果未知",
    "cap.waiting": "等待验证邮件",
    "cap.choose": "有多个候选，选出验证码",
    "cap.candidates": "{n} 个候选码",
    "cap.noSubject": "（无标题）",
    "cap.noCode": "邮件到了，但没认出验证码",
    "cap.linkOpened": "已打开验证链接",
    "cap.codeFilled": "已填入验证码",
    "cap.codeAndLink": "验证码 + 链接",
    "cap.codeArrived": "收到验证码",
    "cap.linkArrived": "收到验证链接",
    "cap.reporting": "正在上报注册成功…",
    "cap.reportUnknown": "上报结果待确认",
    "cap.reported": "已上报成功，邮箱仍在收件",
    "cap.closing": "正在关闭邮箱…",
    "cap.closeFailed": "关闭邮箱失败",
    "cap.closed": "已结束 · {provider}",
    "cap.auto": "自动分配",
    // capsule buttons
    "act.get": "获取邮箱",
    "act.getting": "获取中",
    "act.retryGet": "重新获取",
    "act.fill": "填入",
    "act.fillAgain": "再填一次",
    "act.choose": "选一个",
    "act.viewMessage": "查看邮件",
    "act.finish": "注册成功并结束",
    "act.reportingBusy": "上报中",
    "act.end": "结束使用",
    "act.closingBusy": "关闭中",
    "act.retryClose": "重试关闭",
    "act.open": "打开",
    "act.getNew": "获取新邮箱",
    // panel chrome
    "ui.assistant": "Mail Hub 邮箱助手",
    "ui.openAssistant": "打开 Mail Hub 邮箱助手",
    "ui.clickToCopy": "点击复制",
    "ui.openLink": "打开验证链接",
    "ui.openLinkTo": "打开验证链接：{domain}",
    "ui.expand": "展开详情",
    "ui.collapse": "收起详情",
    "ui.fold": "收起到边缘",
    // connect form
    "connect.leadFirst": "连接你自己的 Mail Hub。密钥只存在脚本管理器里，不会写进当前网页。",
    "connect.leadAdd": "添加一套连接。地址和 Key 一起保存，之后在抽屉底部就能切换。",
    "connect.leadEdit": "编辑这套连接。地址和 Key 一起保存，切换时一起生效。",
    "connect.label": "名称（可选）",
    "connect.labelPlaceholder": "比如 家里、VPS",
    "connect.base": "服务地址",
    "connect.insecure": "这是 HTTP 连接，API Key 会明文经过网络。对外的地址请改用 https。",
    "connect.cancel": "取消",
    "connect.submitFirst": "连接",
    "connect.submitAdd": "添加并切换",
    "connect.submitEdit": "保存",
    "connect.needKey": "请填写 API Key",
    // drawer
    "drawer.service": "服务",
    "drawer.editService": "修改服务标识",
    "drawer.serviceInput": "服务标识",
    "drawer.save": "保存",
    "drawer.serviceMissing": "认不出，需要填写",
    "drawer.foreign": "这个邮箱属于 {service}，上报也算在它名下。",
    "drawer.provider": "提供商",
    "drawer.providerSelect": "邮箱提供商",
    "drawer.providerAuto": "自动分配 · 按服务顺序",
    "drawer.disabled": "（已停用）",
    "drawer.noPolling": "（不支持收件）",
    "drawer.limited": "（限流中）",
    "drawer.address": "邮箱",
    "drawer.copy": "复制",
    "drawer.fill": "填入",
    "drawer.replace": "换一个",
    "drawer.replaceWarning": "当前邮箱会被关闭，不上报结果。",
    "drawer.cancel": "取消",
    "drawer.replaceConfirm": "结束并换邮箱",
    "drawer.mail": "邮件",
    "drawer.previousMail": "上一封邮件",
    "drawer.open": "打开",
    "drawer.viewMail": "查看邮件",
    "drawer.hideMail": "收起邮件",
    "drawer.loadingBody": "正在读取…",
    "drawer.continue": "继续收取",
    "drawer.finish": "注册成功并结束",
    "drawer.end": "结束使用",
    "drawer.reportOnly": "只上报成功，邮箱继续收件",
    "drawer.connection": "连接",
    "drawer.connectionNow": "连接：{name}",
    "drawer.switchConnection": "切换连接",
    "drawer.settings": "设置",
    // time
    "time.secondsAgo": "{n} 秒前",
    "time.minutesAgo": "{n} 分钟前",
    "time.hoursAgo": "{n} 小时前",
    "time.expired": "已过期",
    "time.expiresHours": "{n} 小时后过期",
    "time.expiresMinutes": "{n} 分钟后过期",
    // settings
    "set.title": "设置",
    "set.back": "返回",
    "set.appearance": "外观",
    "set.themeSystem": "跟随系统",
    "set.themeLight": "亮色",
    "set.themeDark": "暗色",
    "set.language": "语言",
    "set.langAuto": "跟随浏览器",
    "set.summon": "唤出",
    "set.change": "修改",
    "set.connections": "连接",
    "set.addConnection": "＋ 添加连接",
    "set.current": "当前",
    "set.currentConnection": "当前连接",
    "set.switchTo": "切换到这套连接",
    "set.edit": "编辑",
    "set.editNamed": "编辑 {name}",
    "set.delete": "删除",
    "set.deleteNamed": "删除 {name}",
    "set.deleteConfirm": "确认删除",
    "set.deleteConfirmNamed": "确认删除 {name}",
    "set.deleteAgain": "再点一次删除",
    "set.resetSeen": "重置收件记录",
    "set.hideVisit": "本次不显示（刷新或快捷键可唤回）",
    "set.hideSite": "不再在这个网站显示",
    // feedback (status line)
    "fb.copied": "已复制",
    "fb.copyFailed": "无法自动复制，请手动选中",
    "fb.filledEmail": "已填入邮箱",
    "fb.filledCode": "已填入验证码",
    "fb.noEmailField": "没找到邮箱输入框，已复制",
    "fb.noCodeField": "没找到验证码输入框，已复制",
    "fb.badLink": "链接不可用",
    "fb.httpOnly": "只支持 http(s) 链接",
    "fb.badService": "服务标识不可用",
    "fb.serviceSet": "服务标识：{service}",
    "fb.switched": "已切换到 {name}",
    "fb.deleted": "已删除这套连接",
    "fb.reportedKeep": "已上报成功，邮箱继续收件",
    "fb.seenReset": "已重置收件记录",
    "fb.recordShortcut": "按下新的组合键（要含 Ctrl / Alt / Shift），Esc 取消",
    "fb.cancelled": "已取消",
    "fb.needModifier": "要同时按 Ctrl / Alt / Shift 中的至少一个",
    "fb.shortcutSet": "唤出快捷键：{shortcut}",
    "fb.language": "语言：中文",
    // notices: short label for the status line, detail for the drawer
    "note.inboxGone": "邮箱已被关闭或删除",
    "note.seenFull": "收件记录已满",
    "note.seenFullDetail": "已排除的邮件到了上限。到设置里点「重置收件记录」后继续收件。",
    "note.pollError": "收件出错，稍后自动重试",
    "note.providersFailed": "读取提供商失败",
    "note.createUnknownDetail": "请求发出后没收到回应，邮箱可能已经创建。确认后再获取。",
    "note.reportUnknown": "上报结果待确认",
    "note.reportUnknownDetail": "没收到服务端确认，可能已经计数，所以不会自动重发。",
    "note.closeUnknown": "关闭结果待确认",
    "note.closeUnknownDetail": "邮箱还在，可以点「重试关闭」。",
    "note.serverGone": "这个邮箱在服务端已不存在",
    "note.verifyFailed": "核对邮箱状态失败",
    "note.needService": "先填写服务标识",
    "note.needServiceDetail": "认不出当前网站的主域名（例如本机地址或 IP），填一个服务标识后再获取。",
    "note.createUnknown": "获取结果未知",
    "note.createUnknownAfter": "{error}。邮箱可能已经创建，确认后再重试。",
    "note.createFailed": "获取失败",
    "note.reportUnknownAfter": "{error}。不会自动重发，也不会自动关闭。",
    "note.reportUnknownKeep": "{error}。不会自动重发。",
    "note.reportFailed": "上报失败",
    "note.reportFailedAfter": "{error}。邮箱没有关闭。",
    "note.closeFailed": "关闭失败",
    "note.closeFailedAfter": "{error}。可以重试。",
    "note.readFailed": "读取失败：{error}",
    // errors
    "err.unauthorized": "API Key 无效或已停用",
    "err.forbidden": "这个 Key 没有该操作的权限",
    "err.notFound": "邮箱不存在或已被删除",
    "err.quotaAfter": "触发限流，{after} 后再试",
    "err.quota": "触发 Mail Hub 限流，稍后再试",
    "err.upstream": "Mail Hub 或上游出错（5xx），稍后再试",
    "err.network": "连不上 Mail Hub（这不代表网站拒绝了注册）",
    "err.timeout": "请求超时，结果待确认",
    "err.aborted": "请求已取消",
    "err.protocol": "响应格式不对，已丢弃",
    "err.seenFull": "已排除的邮件过多，需要先重置收件记录",
    "err.badService": "服务标识不可用",
    "err.noInbox": "还没有可用的邮箱",
    "url.empty": "请填写 Mail Hub 地址",
    "url.invalid": "地址无法解析",
    "url.scheme": "只支持 http 或 https 地址",
    "url.credentials": "地址里不能带用户名或密码",
    "url.query": "地址里不能带查询参数",
    "url.hash": "地址里不能带 # 片段",
    // script-manager menu
    "menu.open": "打开 Mail Hub 邮箱助手",
    "menu.deleteConnection": "删除当前 Mail Hub 连接"
  };
  var en = {
    "cap.connectTitle": "Connect your Mail Hub",
    "cap.notConnected": "Not connected",
    "cap.noInbox": "No inbox yet",
    "cap.unknownSite": "Unrecognised site",
    "cap.needService": "Set a service name first",
    "cap.getting": "Getting an inbox…",
    "cap.createUnknown": "Result unknown",
    "cap.waiting": "Waiting for the email",
    "cap.choose": "Several candidates — pick the code",
    "cap.candidates": "{n} candidates",
    "cap.noSubject": "(no subject)",
    "cap.noCode": "Mail arrived, no code found",
    "cap.linkOpened": "Link opened",
    "cap.codeFilled": "Code filled in",
    "cap.codeAndLink": "Code + link",
    "cap.codeArrived": "Code received",
    "cap.linkArrived": "Link received",
    "cap.reporting": "Reporting success…",
    "cap.reportUnknown": "Report unconfirmed",
    "cap.reported": "Reported — still receiving",
    "cap.closing": "Closing the inbox…",
    "cap.closeFailed": "Could not close",
    "cap.closed": "Done · {provider}",
    "cap.auto": "Auto",
    "act.get": "Get inbox",
    "act.getting": "Getting",
    "act.retryGet": "Try again",
    "act.fill": "Fill",
    "act.fillAgain": "Fill again",
    "act.choose": "Pick one",
    "act.viewMessage": "Read mail",
    "act.finish": "Done, it worked",
    "act.reportingBusy": "Reporting",
    "act.end": "Close inbox",
    "act.closingBusy": "Closing",
    "act.retryClose": "Retry close",
    "act.open": "Open",
    "act.getNew": "New inbox",
    "ui.assistant": "Mail Hub assistant",
    "ui.openAssistant": "Open the Mail Hub assistant",
    "ui.clickToCopy": "Click to copy",
    "ui.openLink": "Open the verification link",
    "ui.openLinkTo": "Open the verification link: {domain}",
    "ui.expand": "Show details",
    "ui.collapse": "Hide details",
    "ui.fold": "Tuck to the edge",
    "connect.leadFirst": "Connect your own Mail Hub. The key stays in the script manager and is never written into the page.",
    "connect.leadAdd": "Add a connection. Address and key are saved together; switch between them at the bottom of the drawer.",
    "connect.leadEdit": "Edit this connection. Address and key are saved, and switched, together.",
    "connect.label": "Name (optional)",
    "connect.labelPlaceholder": "e.g. Home, VPS",
    "connect.base": "Mail Hub address",
    "connect.insecure": "This is a plain HTTP connection: the API key crosses the network unencrypted. Use https for anything not on this machine.",
    "connect.cancel": "Cancel",
    "connect.submitFirst": "Connect",
    "connect.submitAdd": "Add and switch",
    "connect.submitEdit": "Save",
    "connect.needKey": "Enter an API key",
    "drawer.service": "Service",
    "drawer.editService": "Change the service name",
    "drawer.serviceInput": "Service name",
    "drawer.save": "Save",
    "drawer.serviceMissing": "Unrecognised — enter one",
    "drawer.foreign": "This inbox belongs to {service}; reports count there.",
    "drawer.provider": "Provider",
    "drawer.providerSelect": "Mail provider",
    "drawer.providerAuto": "Auto · service order",
    "drawer.disabled": " (disabled)",
    "drawer.noPolling": " (cannot receive)",
    "drawer.limited": " (rate limited)",
    "drawer.address": "Inbox",
    "drawer.copy": "Copy",
    "drawer.fill": "Fill",
    "drawer.replace": "Swap",
    "drawer.replaceWarning": "This inbox will be closed without reporting a result.",
    "drawer.cancel": "Cancel",
    "drawer.replaceConfirm": "Close and swap",
    "drawer.mail": "Mail",
    "drawer.previousMail": "Previous mail",
    "drawer.open": "Open",
    "drawer.viewMail": "Read mail",
    "drawer.hideMail": "Hide mail",
    "drawer.loadingBody": "Loading…",
    "drawer.continue": "Keep receiving",
    "drawer.finish": "Done, it worked",
    "drawer.end": "Close inbox",
    "drawer.reportOnly": "Report success, keep receiving",
    "drawer.connection": "Connection",
    "drawer.connectionNow": "Connection: {name}",
    "drawer.switchConnection": "Switch connection",
    "drawer.settings": "Settings",
    "time.secondsAgo": "{n}s ago",
    "time.minutesAgo": "{n} min ago",
    "time.hoursAgo": "{n} h ago",
    "time.expired": "expired",
    "time.expiresHours": "expires in {n} h",
    "time.expiresMinutes": "expires in {n} min",
    "set.title": "Settings",
    "set.back": "Back",
    "set.appearance": "Theme",
    "set.themeSystem": "System",
    "set.themeLight": "Light",
    "set.themeDark": "Dark",
    "set.language": "Language",
    "set.langAuto": "Browser",
    "set.summon": "Shortcut",
    "set.change": "Change",
    "set.connections": "Connections",
    "set.addConnection": "+ Add connection",
    "set.current": "current",
    "set.currentConnection": "Current connection",
    "set.switchTo": "Switch to this connection",
    "set.edit": "Edit",
    "set.editNamed": "Edit {name}",
    "set.delete": "Delete",
    "set.deleteNamed": "Delete {name}",
    "set.deleteConfirm": "Confirm",
    "set.deleteConfirmNamed": "Confirm deleting {name}",
    "set.deleteAgain": "Click again to delete",
    "set.resetSeen": "Reset received-mail list",
    "set.hideVisit": "Hide for now (reload or shortcut brings it back)",
    "set.hideSite": "Never show on this site",
    "fb.copied": "Copied",
    "fb.copyFailed": "Could not copy — select it by hand",
    "fb.filledEmail": "Email filled in",
    "fb.filledCode": "Code filled in",
    "fb.noEmailField": "No email field found — copied instead",
    "fb.noCodeField": "No code field found — copied instead",
    "fb.badLink": "Link unusable",
    "fb.httpOnly": "Only http(s) links open",
    "fb.badService": "Service name not usable",
    "fb.serviceSet": "Service: {service}",
    "fb.switched": "Switched to {name}",
    "fb.deleted": "Connection deleted",
    "fb.reportedKeep": "Reported — still receiving",
    "fb.seenReset": "Received-mail list reset",
    "fb.recordShortcut": "Press the new combination (with Ctrl / Alt / Shift); Esc cancels",
    "fb.cancelled": "Cancelled",
    "fb.needModifier": "Hold Ctrl, Alt or Shift as well",
    "fb.shortcutSet": "Shortcut: {shortcut}",
    "fb.language": "Language: English",
    "note.inboxGone": "Inbox closed or deleted",
    "note.seenFull": "Received-mail list full",
    "note.seenFullDetail": "The list of mail already seen hit its limit. Reset it in settings to keep receiving.",
    "note.pollError": "Receive error — retrying",
    "note.providersFailed": "Could not load providers",
    "note.createUnknownDetail": "The request got no answer; the inbox may already exist. Check before getting another.",
    "note.reportUnknown": "Report unconfirmed",
    "note.reportUnknownDetail": "No confirmation from the server; it may already have counted, so it is not resent.",
    "note.closeUnknown": "Close unconfirmed",
    "note.closeUnknownDetail": "The inbox is still open. Press Retry close.",
    "note.serverGone": "This inbox no longer exists on the server",
    "note.verifyFailed": "Could not check the inbox",
    "note.needService": "Set a service name first",
    "note.needServiceDetail": "This site has no recognisable main domain (a local address or IP, for example). Enter a service name, then get an inbox.",
    "note.createUnknown": "Result unknown",
    "note.createUnknownAfter": "{error}. The inbox may already exist; check before retrying.",
    "note.createFailed": "Could not get an inbox",
    "note.reportUnknownAfter": "{error}. Not resent, and the inbox is not closed.",
    "note.reportUnknownKeep": "{error}. Not resent.",
    "note.reportFailed": "Report failed",
    "note.reportFailedAfter": "{error}. The inbox was not closed.",
    "note.closeFailed": "Close failed",
    "note.closeFailedAfter": "{error}. You can retry.",
    "note.readFailed": "Could not load: {error}",
    "err.unauthorized": "API key invalid or disabled",
    "err.forbidden": "This key may not do that",
    "err.notFound": "Inbox not found or deleted",
    "err.quotaAfter": "Rate limited — try again after {after}",
    "err.quota": "Mail Hub rate limit hit — try again shortly",
    "err.upstream": "Mail Hub or upstream error (5xx) — try again shortly",
    "err.network": "Cannot reach Mail Hub (the site did not reject anything)",
    "err.timeout": "Request timed out — result unknown",
    "err.aborted": "Request cancelled",
    "err.protocol": "Unexpected response — discarded",
    "err.seenFull": "Too many messages excluded; reset the received-mail list first",
    "err.badService": "Service name not usable",
    "err.noInbox": "No inbox to use yet",
    "url.empty": "Enter the Mail Hub address",
    "url.invalid": "That address cannot be parsed",
    "url.scheme": "Only http or https addresses work",
    "url.credentials": "The address cannot contain a user name or password",
    "url.query": "The address cannot contain query parameters",
    "url.hash": "The address cannot contain a # fragment",
    "menu.open": "Open the Mail Hub assistant",
    "menu.deleteConnection": "Delete the current Mail Hub connection"
  };
  var DICTIONARIES = { zh, en };
  var current = "zh";
  function resolveLang(preference, browserLanguages) {
    if (preference !== "auto") return preference;
    const first = browserLanguages.find((language) => language.trim() !== "") ?? "";
    return first.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  function setLang(lang) {
    current = lang;
  }
  function currentLang() {
    return current;
  }
  function t(key, vars = {}) {
    const template = DICTIONARIES[current][key] ?? DICTIONARIES.zh[key];
    return template.replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match);
  }

  // node_modules/tldts-core/dist/es6/src/domain.js
  function shareSameDomainSuffix(hostname, vhost) {
    if (hostname.endsWith(vhost)) {
      return hostname.length === vhost.length || hostname[hostname.length - vhost.length - 1] === ".";
    }
    return false;
  }
  function extractDomainWithSuffix(hostname, publicSuffix) {
    const publicSuffixIndex = hostname.length - publicSuffix.length - 2;
    const lastDotBeforeSuffixIndex = hostname.lastIndexOf(".", publicSuffixIndex);
    if (lastDotBeforeSuffixIndex === -1) {
      return hostname;
    }
    return hostname.slice(lastDotBeforeSuffixIndex + 1);
  }
  function getDomain(suffix, hostname, options) {
    if (options.validHosts !== null) {
      const validHosts = options.validHosts;
      for (const vhost of validHosts) {
        if (
          /*@__INLINE__*/
          shareSameDomainSuffix(hostname, vhost)
        ) {
          return vhost;
        }
      }
    }
    let numberOfLeadingDots = 0;
    if (hostname.startsWith(".")) {
      while (numberOfLeadingDots < hostname.length && hostname[numberOfLeadingDots] === ".") {
        numberOfLeadingDots += 1;
      }
    }
    if (suffix.length === hostname.length - numberOfLeadingDots) {
      return null;
    }
    return (
      /*@__INLINE__*/
      extractDomainWithSuffix(hostname, suffix)
    );
  }

  // node_modules/tldts-core/dist/es6/src/domain-without-suffix.js
  function getDomainWithoutSuffix(domain, suffix) {
    return domain.slice(0, -suffix.length - 1);
  }

  // node_modules/tldts-core/dist/es6/src/extract-hostname.js
  var CONTROL_CHARS = /[\t\n\r]/g;
  var extractedHostnameValidated = false;
  function isValidHostnameChar(code) {
    return code >= 97 && code <= 122 || // a-z
    code >= 48 && code <= 57 || // 0-9
    code > 127 || // non-ASCII (accepted, not punycode-checked)
    code >= 65 && code <= 90 || // A-Z (becomes valid once lowercased)
    code === 45 || // '-'
    code === 95;
  }
  function getSpecialScheme(url, schemeStart, colonIndex) {
    const length = colonIndex - schemeStart;
    const c0 = url.charCodeAt(schemeStart) | 32;
    if (length === 2) {
      return c0 === 119 && (url.charCodeAt(schemeStart + 1) | 32) === 115 ? 1 : 0;
    } else if (length === 3) {
      const c1 = url.charCodeAt(schemeStart + 1) | 32;
      const c2 = url.charCodeAt(schemeStart + 2) | 32;
      if (c0 === 119 && c1 === 115 && c2 === 115)
        return 1;
      if (c0 === 102 && c1 === 116 && c2 === 112)
        return 1;
      return 0;
    } else if (length === 4) {
      const c1 = url.charCodeAt(schemeStart + 1) | 32;
      const c2 = url.charCodeAt(schemeStart + 2) | 32;
      const c3 = url.charCodeAt(schemeStart + 3) | 32;
      if (c0 === 104 && c1 === 116 && c2 === 116 && c3 === 112)
        return 1;
      if (c0 === 102 && c1 === 105 && c2 === 108 && c3 === 101)
        return 2;
      return 0;
    } else if (length === 5) {
      return c0 === 104 && (url.charCodeAt(schemeStart + 1) | 32) === 116 && (url.charCodeAt(schemeStart + 2) | 32) === 116 && (url.charCodeAt(schemeStart + 3) | 32) === 112 && (url.charCodeAt(schemeStart + 4) | 32) === 115 ? 1 : 0;
    }
    return 0;
  }
  function extractHostname(url, urlIsValidHostname, validate = false) {
    let start = 0;
    let end = url.length;
    let hasUpper = false;
    let isSpecial = true;
    extractedHostnameValidated = false;
    if (!urlIsValidHostname) {
      while (start < url.length && url.charCodeAt(start) <= 32) {
        start += 1;
      }
      if (url.charCodeAt(start + 4) === 58 && (url.charCodeAt(start) | 32) === 100 && (url.charCodeAt(start + 1) | 32) === 97 && (url.charCodeAt(start + 2) | 32) === 116 && (url.charCodeAt(start + 3) | 32) === 97 || url.charCodeAt(start + 10) === 58 && (url.charCodeAt(start) | 32) === 106 && (url.charCodeAt(start + 1) | 32) === 97 && (url.charCodeAt(start + 2) | 32) === 118 && (url.charCodeAt(start + 3) | 32) === 97 && (url.charCodeAt(start + 4) | 32) === 115 && (url.charCodeAt(start + 5) | 32) === 99 && (url.charCodeAt(start + 6) | 32) === 114 && (url.charCodeAt(start + 7) | 32) === 105 && (url.charCodeAt(start + 8) | 32) === 112 && (url.charCodeAt(start + 9) | 32) === 116) {
        return null;
      }
      while (end > start + 1 && url.charCodeAt(end - 1) <= 32) {
        end -= 1;
      }
      if ((url.charCodeAt(start) === 47 || url.charCodeAt(start) === 92) && (url.charCodeAt(start + 1) === 47 || url.charCodeAt(start + 1) === 92)) {
        start += 2;
      } else {
        let indexOfProtocol = url.indexOf(":/", start);
        if (indexOfProtocol !== -1) {
          const special = getSpecialScheme(url, start, indexOfProtocol);
          if (special === 1) {
            start = indexOfProtocol + 2;
            while (url.charCodeAt(start) === 47 || url.charCodeAt(start) === 92) {
              start += 1;
            }
          } else if (special === 2) {
            start = indexOfProtocol + 1;
            let slashes = 0;
            while ((url.charCodeAt(start) === 47 || url.charCodeAt(start) === 92) && slashes < 2) {
              start += 1;
              slashes += 1;
            }
            if (slashes < 2) {
              return null;
            }
          } else {
            for (let i = start; i < indexOfProtocol; i += 1) {
              const code = url.charCodeAt(i);
              if (!((code | 32) >= 97 && (code | 32) <= 122 || // [a-zA-Z] (fold letters only)
              code >= 48 && code <= 57 || // [0, 9]
              code === 46 || // '.'
              code === 45 || // '-'
              code === 43)) {
                if (code === 9 || code === 10 || code === 13) {
                  return extractHostname(url.replace(CONTROL_CHARS, ""), urlIsValidHostname, validate);
                }
                for (let j = i; j < indexOfProtocol; j += 1) {
                  const c = url.charCodeAt(j);
                  if (c === 47 || c === 92 || c === 63 || c === 35) {
                    indexOfProtocol = -1;
                    break;
                  }
                }
                if (indexOfProtocol !== -1) {
                  return null;
                }
                break;
              }
            }
            if (indexOfProtocol !== -1) {
              if (url.charCodeAt(indexOfProtocol + 2) === 47) {
                isSpecial = false;
                start = indexOfProtocol + 3;
              } else {
                return null;
              }
            }
          }
        }
        if (indexOfProtocol === -1 && url.charCodeAt(start) !== 91) {
          let indexOfColon = -1;
          for (let i = start; i < end; i += 1) {
            const code = url.charCodeAt(i);
            if (code === 9 || code === 10 || code === 13) {
              return extractHostname(url.replace(CONTROL_CHARS, ""), urlIsValidHostname, validate);
            }
            if (code === 58) {
              indexOfColon = i;
              break;
            }
            if (code === 47 || code === 92 || code === 63 || code === 35) {
              break;
            }
          }
          if (indexOfColon !== -1) {
            let hasIdentifier = false;
            for (let i = indexOfColon + 1; i < end; i += 1) {
              const code = url.charCodeAt(i);
              if (code === 47 || code === 92 || code === 63 || code === 35) {
                break;
              }
              if (code === 64) {
                hasIdentifier = true;
                break;
              }
            }
            if (!hasIdentifier) {
              let allDigits = true;
              let i = indexOfColon + 1;
              for (; i < end; i += 1) {
                const code = url.charCodeAt(i);
                if (code === 47 || code === 92 || code === 63 || code === 35) {
                  break;
                }
                if (code < 48 || code > 57) {
                  allDigits = false;
                  break;
                }
              }
              if (i === indexOfColon + 1) {
                allDigits = false;
              }
              if (!allDigits) {
                const special = getSpecialScheme(url, start, indexOfColon);
                if (special === 0) {
                  let isBareIpv6 = false;
                  for (let j = indexOfColon + 1; j < end; j += 1) {
                    const code = url.charCodeAt(j);
                    if (code === 47 || code === 92 || code === 63 || code === 35) {
                      break;
                    }
                    if (code === 58) {
                      isBareIpv6 = true;
                      break;
                    }
                  }
                  if (!isBareIpv6) {
                    return null;
                  }
                } else {
                  start = indexOfColon + 1;
                  if (special === 2) {
                    let slashes = 0;
                    while ((url.charCodeAt(start) === 47 || url.charCodeAt(start) === 92) && slashes < 2) {
                      start += 1;
                      slashes += 1;
                    }
                    if (slashes < 2) {
                      return null;
                    }
                  } else {
                    while (url.charCodeAt(start) === 47 || url.charCodeAt(start) === 92) {
                      start += 1;
                    }
                  }
                }
              }
            }
          }
        }
      }
      let indexOfIdentifier = -1;
      let indexOfClosingBracket = -1;
      let indexOfPort = -1;
      let indexOfFirstColon = -1;
      let hasControl = false;
      let vValid = validate;
      let vLastDot = start - 1;
      let vLastCode = -1;
      if (validate && start < end) {
        const c0 = url.charCodeAt(start);
        if (
          // Keep these parens: they scope /*@__INLINE__*/ for terser.
          // prettier-ignore
          !/*@__INLINE__*/
          (isValidHostnameChar(c0) || c0 === 46 || c0 === 95) || c0 === 45
        ) {
          vValid = false;
        }
      }
      for (let i = start; i < end; i += 1) {
        const code = url.charCodeAt(i);
        if (code < 64) {
          if (code === 47 || code === 35 || code === 63) {
            end = i;
            break;
          } else if (code === 58) {
            if (indexOfFirstColon === -1) {
              indexOfFirstColon = i;
            }
            indexOfPort = i;
          } else if (code === 9 || code === 10 || code === 13) {
            hasControl = true;
          } else if (validate) {
            if (code === 46) {
              if (i - vLastDot > 64 || vLastCode === 46 || vLastCode === 45) {
                vValid = false;
              }
              vLastDot = i;
            } else if (code < 48 || code > 57) {
              if (code !== 45 || vLastCode === 46) {
                vValid = false;
              }
            }
          }
        } else if (isSpecial && code === 92) {
          end = i;
          break;
        } else if (code === 64) {
          indexOfIdentifier = i;
          indexOfFirstColon = -1;
        } else if (code === 93) {
          indexOfClosingBracket = i;
        } else if (code >= 65 && code <= 90) {
          hasUpper = true;
        } else if (validate && !/*@__INLINE__*/
        isValidHostnameChar(code)) {
          vValid = false;
        }
        if (validate) {
          vLastCode = code;
        }
      }
      if (hasControl) {
        return extractHostname(url.replace(CONTROL_CHARS, ""), urlIsValidHostname, validate);
      }
      if (indexOfIdentifier !== -1 && indexOfIdentifier >= start && indexOfIdentifier < end) {
        start = indexOfIdentifier + 1;
      }
      if (url.charCodeAt(start) === 91) {
        if (indexOfClosingBracket !== -1) {
          return url.slice(start + 1, indexOfClosingBracket).toLowerCase();
        }
        return null;
      } else if (indexOfPort !== -1 && indexOfPort > start && indexOfPort < end && // A host:port has exactly one ':' in the host (so its first ':' is its
      // last); a bare, unbracketed IPv6 literal ("2a01:e35::1") has >= 2, so
      // its first ':' precedes the last. Only the former has a ':port' to trim.
      indexOfFirstColon === indexOfPort) {
        end = indexOfPort;
      }
      if (start >= end) {
        return null;
      }
      if (validate && vValid && indexOfIdentifier === -1 && indexOfPort === -1 && indexOfClosingBracket === -1 && url.charCodeAt(end - 1) !== 46 && end - start <= 255 && // total length
      end - vLastDot - 1 <= 63 && // last label length
      vLastCode !== 45) {
        extractedHostnameValidated = true;
      }
    }
    while (end > start + 1 && url.charCodeAt(end - 1) === 46) {
      end -= 1;
    }
    const hostname = start !== 0 || end !== url.length ? url.slice(start, end) : url;
    if (hasUpper) {
      return hostname.toLowerCase();
    }
    return hostname;
  }

  // node_modules/tldts-core/dist/es6/src/is-ip.js
  function isProbablyIpv4(hostname) {
    if (hostname.length < 7) {
      return false;
    }
    if (hostname.length > 15) {
      return false;
    }
    let numberOfDots = 0;
    for (let i = 0; i < hostname.length; i += 1) {
      const code = hostname.charCodeAt(i);
      if (code === 46) {
        numberOfDots += 1;
      } else if (code < 48 || code > 57) {
        return false;
      }
    }
    return numberOfDots === 3 && hostname.charCodeAt(0) !== 46 && hostname.charCodeAt(hostname.length - 1) !== 46;
  }
  function isProbablyIpv6(hostname) {
    if (hostname.length < 3) {
      return hostname === "::";
    }
    let start = hostname.startsWith("[") ? 1 : 0;
    let end = hostname.length;
    if (hostname[end - 1] === "]") {
      end -= 1;
    }
    if (end - start > 39) {
      return false;
    }
    let hasColon = false;
    for (; start < end; start += 1) {
      const code = hostname.charCodeAt(start);
      if (code === 58) {
        hasColon = true;
      } else if (!(code >= 48 && code <= 57 || // 0-9
      code >= 97 && code <= 102 || // a-f
      code >= 65 && code <= 70)) {
        return false;
      }
    }
    return hasColon;
  }
  function isIp(hostname) {
    return isProbablyIpv6(hostname) || isProbablyIpv4(hostname);
  }

  // node_modules/tldts-core/dist/es6/src/is-special-use.js
  var SPECIAL_USE_DOMAINS = [
    "test",
    // RFC 6761
    "localhost",
    // RFC 6761
    "invalid",
    // RFC 6761
    "example",
    // RFC 6761
    "example.com",
    // RFC 6761
    "example.net",
    // RFC 6761
    "example.org",
    // RFC 6761
    "local",
    // RFC 6762 (mDNS)
    "onion",
    // RFC 7686 (Tor)
    "alt",
    // RFC 9476
    "home.arpa",
    // RFC 8375
    "ipv4only.arpa",
    // RFC 8880
    "resolver.arpa",
    // RFC 9462
    "service.arpa",
    // RFC 9665
    "6tisch.arpa",
    // RFC 9031
    "eap.arpa"
    // RFC 9965
  ];
  function isSpecialUse(hostname) {
    for (const name of SPECIAL_USE_DOMAINS) {
      if (hostname.endsWith(name) && (hostname.length === name.length || hostname.charCodeAt(hostname.length - name.length - 1) === 46)) {
        return true;
      }
    }
    return false;
  }

  // node_modules/tldts-core/dist/es6/src/is-valid.js
  function isValidAscii(code) {
    return code >= 97 && code <= 122 || code >= 48 && code <= 57 || code > 127;
  }
  function is_valid_default(hostname) {
    if (hostname.length > 255) {
      return false;
    }
    if (hostname.length === 0) {
      return false;
    }
    if (
      /*@__INLINE__*/
      !isValidAscii(hostname.charCodeAt(0)) && hostname.charCodeAt(0) !== 46 && // '.' (dot)
      hostname.charCodeAt(0) !== 95
    ) {
      return false;
    }
    let lastDotIndex = -1;
    let lastCharCode = -1;
    const len = hostname.length;
    for (let i = 0; i < len; i += 1) {
      const code = hostname.charCodeAt(i);
      if (code === 46) {
        if (
          // Check that previous label is < 63 bytes long (64 = 63 + '.')
          i - lastDotIndex > 64 || // Check that previous character was not already a '.'
          lastCharCode === 46 || // Check that the previous label does not end with '-' (RFC 1035 §2.3.1 LDH).
          // '_' is intentionally NOT restricted: DNS allows any octet (RFC 2181 §11) and
          // WHATWG URL does not treat '_' as a forbidden host code point.
          lastCharCode === 45
        ) {
          return false;
        }
        lastDotIndex = i;
      } else if (
        // A forbidden character in the label...
        // Keep these parens: they scope /*@__INLINE__*/ for terser.
        // prettier-ignore
        !/*@__INLINE__*/
        (isValidAscii(code) || code === 45 || code === 95) || // ...or a '-' starting a label (the byte right after a '.'). A label must
        // not begin with a hyphen (RFC 1034 §3.5 / RFC 1035 §2.3.1 LDH, as amended
        // by RFC 1123 §2.1; cf. UTS #46 CheckHyphens). The first label is covered by
        // the leading-character guard above; mirrors the trailing-'-' rule below.
        code === 45 && lastCharCode === 46
      ) {
        return false;
      }
      lastCharCode = code;
    }
    return (
      // Check that last label is shorter than 63 chars
      len - lastDotIndex - 1 <= 63 && // Check that the last character is an allowed trailing label character.
      // Since we already checked that the char is a valid hostname character,
      // we only need to check that it's different from '-'.
      lastCharCode !== 45
    );
  }

  // node_modules/tldts-core/dist/es6/src/lookup/extra-suffixes.js
  function extraSuffixLookup(hostname, options, isException, out) {
    const suffix = out.publicSuffix;
    if (suffix === null) {
      return;
    }
    const none = hostname.length + 1;
    let exception = none;
    let exceptionIsIcann = false;
    let rule = none;
    let ruleIsIcann = false;
    const extra = options.extraSuffixes;
    for (let section = 0; section < 2; section += 1) {
      const isIcann = section === 0;
      const rules = isIcann ? options.allowIcannDomains && extra.icann : options.allowPrivateDomains && extra.private;
      if (!Array.isArray(rules)) {
        continue;
      }
      for (const r of rules) {
        if (typeof r !== "string") {
          continue;
        }
        const exceptionRule = r.startsWith("!");
        const wildcard = r.startsWith("*.");
        const body = exceptionRule ? r.slice(1) : wildcard ? r.slice(2) : r;
        if (body === "" || exceptionRule && !body.includes(".") || !shareSameDomainSuffix(hostname, body)) {
          continue;
        }
        let start = hostname.length - body.length;
        if (exceptionRule) {
          if (start < exception) {
            exception = start;
            exceptionIsIcann = isIcann;
          }
          continue;
        }
        if (wildcard && start > 1 && hostname.charCodeAt(start - 2) !== 46) {
          start = hostname.lastIndexOf(".", start - 2) + 1;
        }
        if (start < rule) {
          rule = start;
          ruleIsIcann = isIcann;
        }
      }
    }
    const suffixStart = hostname.length - suffix.length;
    const builtin = isException ? hostname.lastIndexOf(".", suffixStart - 2) + 1 : suffixStart;
    if (exception <= rule && (isException ? exception < builtin : exception <= builtin)) {
      out.publicSuffix = hostname.slice(hostname.indexOf(".", exception) + 1);
      out.isIcann = exceptionIsIcann;
      out.isPrivate = !exceptionIsIcann;
    } else if (rule < builtin || rule === builtin && !out.isIcann && !out.isPrivate) {
      out.publicSuffix = hostname.slice(rule);
      out.isIcann = ruleIsIcann;
      out.isPrivate = !ruleIsIcann;
    }
  }

  // node_modules/tldts-core/dist/es6/src/options.js
  function setDefaultsImpl({ allowIcannDomains = true, allowPrivateDomains = false, detectIp = true, detectSpecialUse = false, extraSuffixes = null, extractHostname: extractHostname2 = true, mixedInputs = true, validHosts = null, validateHostname = true }) {
    return {
      allowIcannDomains,
      allowPrivateDomains,
      detectIp,
      detectSpecialUse,
      extraSuffixes,
      extractHostname: extractHostname2,
      mixedInputs,
      validHosts,
      validateHostname
    };
  }
  var DEFAULT_OPTIONS = (
    /*@__INLINE__*/
    setDefaultsImpl({})
  );
  function setDefaults(options) {
    if (options === void 0) {
      return DEFAULT_OPTIONS;
    }
    return (
      /*@__INLINE__*/
      setDefaultsImpl(options)
    );
  }

  // node_modules/tldts-core/dist/es6/src/subdomain.js
  function getSubdomain(hostname, domain) {
    if (domain.length === hostname.length) {
      return "";
    }
    return hostname.slice(0, -domain.length - 1);
  }

  // node_modules/tldts-core/dist/es6/src/factory.js
  function getEmptyResult() {
    return {
      domain: null,
      domainWithoutSuffix: null,
      hostname: null,
      isIcann: null,
      isIp: null,
      isPrivate: null,
      isSpecialUse: null,
      publicSuffix: null,
      subdomain: null
    };
  }
  function resetResult(result) {
    result.domain = null;
    result.domainWithoutSuffix = null;
    result.hostname = null;
    result.isIcann = null;
    result.isIp = null;
    result.isPrivate = null;
    result.isSpecialUse = null;
    result.publicSuffix = null;
    result.subdomain = null;
  }
  function parseImpl(url, step, suffixLookup2, partialOptions, result) {
    const options = (
      /*@__INLINE__*/
      setDefaults(partialOptions)
    );
    if (typeof url !== "string") {
      return result;
    }
    let urlIsValid = false;
    if (!options.extractHostname) {
      let end = url.length;
      while (end > 1 && url.charCodeAt(end - 1) === 46) {
        end -= 1;
      }
      result.hostname = end === url.length ? url : url.slice(0, end);
    } else if (options.mixedInputs) {
      urlIsValid = is_valid_default(url);
      result.hostname = extractHostname(url, urlIsValid, options.validateHostname);
    } else {
      result.hostname = extractHostname(url, false, options.validateHostname);
    }
    if (options.detectIp && result.hostname !== null) {
      result.isIp = isIp(result.hostname);
      if (result.isIp) {
        return result;
      }
    }
    if (options.validateHostname && options.extractHostname && result.hostname !== null && // Skip the re-scan when `url` was already validated and extractHostname
    // returned it unchanged (same reference => identical string, still valid).
    !(urlIsValid && result.hostname === url) && // Skip the re-scan when extractHostname already validated the host inline
    // (a confirmed-valid simple authority — see extract-hostname.ts).
    !extractedHostnameValidated && !is_valid_default(result.hostname)) {
      result.hostname = null;
      return result;
    }
    if (step === 0 || result.hostname === null) {
      return result;
    }
    if (step === 5 && options.detectSpecialUse) {
      result.isSpecialUse = isSpecialUse(result.hostname);
    }
    const isException = suffixLookup2(result.hostname, options, result);
    if (options.extraSuffixes !== null) {
      extraSuffixLookup(result.hostname, options, isException === true, result);
    }
    if (step === 2 || result.publicSuffix === null) {
      return result;
    }
    result.domain = getDomain(result.publicSuffix, result.hostname, options);
    if (step === 3 || result.domain === null) {
      return result;
    }
    result.subdomain = getSubdomain(result.hostname, result.domain);
    if (step === 4) {
      return result;
    }
    result.domainWithoutSuffix = getDomainWithoutSuffix(result.domain, result.publicSuffix);
    return result;
  }

  // node_modules/tldts-core/dist/es6/src/lookup/fast-path.js
  function fast_path_default(hostname, options, out) {
    if (!options.allowPrivateDomains && options.allowIcannDomains && hostname.length > 3) {
      const last = hostname.length - 1;
      const c3 = hostname.charCodeAt(last);
      const c2 = hostname.charCodeAt(last - 1);
      const c1 = hostname.charCodeAt(last - 2);
      const c0 = hostname.charCodeAt(last - 3);
      if (c3 === 109 && c2 === 111 && c1 === 99 && c0 === 46) {
        out.isIcann = true;
        out.isPrivate = false;
        out.publicSuffix = "com";
        return true;
      } else if (c3 === 103 && c2 === 114 && c1 === 111 && c0 === 46) {
        out.isIcann = true;
        out.isPrivate = false;
        out.publicSuffix = "org";
        return true;
      } else if (c3 === 117 && c2 === 100 && c1 === 101 && c0 === 46) {
        out.isIcann = true;
        out.isPrivate = false;
        out.publicSuffix = "edu";
        return true;
      } else if (c3 === 118 && c2 === 111 && c1 === 103 && c0 === 46) {
        out.isIcann = true;
        out.isPrivate = false;
        out.publicSuffix = "gov";
        return true;
      } else if (c3 === 116 && c2 === 101 && c1 === 110 && c0 === 46) {
        out.isIcann = true;
        out.isPrivate = false;
        out.publicSuffix = "net";
        return true;
      } else if (c3 === 101 && c2 === 100 && c1 === 46) {
        out.isIcann = true;
        out.isPrivate = false;
        out.publicSuffix = "de";
        return true;
      }
    }
    return false;
  }

  // node_modules/tldts/dist/es6/src/data/trie.js
  var nodeFlags = /* @__PURE__ */ new Uint8Array([1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 0, 2, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 2, 0, 0, 0, 1, 1, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 2, 2, 0, 0, 0, 2, 0, 1, 1, 0, 2, 0, 2, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 2, 2, 0, 2, 2, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 2, 2, 0, 2, 2, 2, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 2, 2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 2, 2, 0, 0, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 2, 2, 1, 2, 1, 1, 1, 2, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  var edgeStart = /* @__PURE__ */ new Uint16Array([0, 0, 0, 10, 11, 18, 106, 111, 117, 124, 130, 136, 145, 146, 147, 148, 149, 150, 151, 153, 154, 156, 157, 158, 160, 162, 234, 247, 249, 250, 251, 266, 273, 274, 277, 278, 279, 282, 284, 303, 304, 306, 315, 320, 337, 338, 341, 342, 344, 346, 382, 383, 385, 388, 389, 393, 395, 399, 402, 434, 437, 450, 451, 459, 460, 462, 472, 486, 487, 488, 489, 498, 499, 536, 541, 557, 577, 583, 625, 627, 628, 629, 656, 683, 684, 832, 838, 841, 842, 843, 848, 853, 862, 884, 885, 886, 887, 888, 889, 890, 908, 910, 911, 914, 916, 917, 919, 921, 936, 951, 956, 957, 959, 960, 961, 962, 963, 965, 968, 973, 974, 975, 977, 978, 981, 984, 985, 986, 999, 1001, 1013, 1024, 1032, 1034, 1074, 1077, 1081, 1082, 1084, 1087, 1098, 1100, 1110, 1112, 1118, 1120, 1121, 1123, 1126, 1127, 1128, 1181, 1183, 1185, 1205, 1206, 1207, 1208, 1210, 1221, 1252, 1263, 1264, 1277, 1287, 1296, 1304, 1305, 1310, 1324, 1335, 1347, 1359, 1373, 1374, 1385, 1419, 1420, 1421, 1437, 1453, 1465, 1538, 1539, 1541, 1542, 1578, 1597, 1598, 1599, 1600, 1601, 1604, 1608, 1611, 1613, 1647, 1648, 1656, 1657, 1658, 1659, 1660, 1661, 1663, 1665, 1667, 1668, 1672, 1673, 1674, 1676, 1678, 1679, 1681, 1682, 1683, 1694, 1696, 1697, 1701, 1702, 1705, 1712, 1713, 1718, 1722, 1723, 1725, 1726, 1727, 1728, 1729, 1730, 1731, 1732, 1733, 1734, 1735, 1736, 1737, 1738, 1740, 1741, 1742, 2202, 2205, 2206, 2208, 2215, 2222, 2232, 2236, 2247, 2248, 2249, 2261, 2262, 2264, 2266, 2267, 2274, 2275, 2277, 2278, 2280, 2281, 2282, 2283, 2284, 2359, 2361, 2382, 2383, 2384, 2386, 2388, 2389, 2442, 2443, 2445, 2452, 2458, 2468, 2478, 2531, 2532, 2533, 2543, 2557, 2558, 2561, 2568, 2569, 2577, 2579, 2580, 2581, 2582, 2593, 2594, 2595, 2597, 2598, 2599, 2608, 2620, 2626, 2658, 2662, 2664, 2665, 2667, 2668, 2679, 2680, 2682, 2690, 2697, 2703, 2708, 2709, 2715, 2718, 2724, 2731, 2732, 2739, 2747, 2748, 2749, 2787, 2793, 2808, 2809, 2814, 2832, 2863, 2881, 2883, 2886, 2894, 2896, 2903, 2955, 2979, 2980, 2981, 2982, 2983, 2984, 2985, 2992, 2993, 2994, 2995, 2996, 2997, 2999, 3e3, 3004, 3084, 3097, 3098, 3535, 3539, 3553, 3605, 3633, 3655, 3713, 3735, 3750, 3813, 3864, 3902, 3938, 3963, 4105, 4151, 4202, 4221, 4255, 4270, 4290, 4320, 4351, 4374, 4405, 4435, 4467, 4494, 4569, 4591, 4629, 4639, 4673, 4692, 4718, 4760, 4810, 4836, 4905, 4906, 4908, 4931, 4954, 4990, 5021, 5038, 5095, 5108, 5132, 5161, 5163, 5197, 5213, 5241, 5546, 5555, 5564, 5571, 5588, 5592, 5598, 5637, 5639, 5646, 5653, 5662, 5669, 5670, 5671, 5683, 5686, 5701, 5702, 5711, 5712, 5721, 5730, 5736, 5738, 5739, 5740, 5777, 5778, 5780, 5788, 5795, 5808, 5812, 5814, 5815, 5821, 5828, 5842, 5852, 5857, 5865, 5873, 5879, 5880, 5884, 5886, 5887, 5899, 5971, 5972, 5973, 5974, 5976, 5977, 5980, 5982, 5985, 5989, 5990, 5991, 5997, 5998, 5999, 6001, 6003, 6005, 6006, 6007, 6010, 6012, 6015, 6016, 6018, 6216, 6223, 6224, 6225, 6235, 6240, 6257, 6271, 6280, 6281, 6282, 6286, 6287, 6289, 6291, 6297, 6298, 6301, 6302, 6304, 6305, 6306, 7206, 7209, 7213, 7231, 7240, 7243, 7250, 7251, 7253, 7254, 7255, 7257, 7309, 7310, 7313, 7314, 7431, 7432, 7443, 7457, 7464, 7467, 7476, 7477, 7478, 7493, 7548, 7740, 7742, 7744, 7745, 7747, 7752, 7765, 7780, 7787, 7796, 7799, 7802, 7809, 7817, 7821, 7822, 7823, 7837, 7841, 7850, 7851, 7852, 7856, 7891, 7892, 7912, 7919, 7927, 7928, 7933, 7941, 7985, 7986, 7992, 7995, 8007, 8012, 8013, 8015, 8017, 8053, 8054, 8060, 8067, 8068, 8078, 8087, 8102, 8106, 8108, 8160, 8161, 8166, 8167, 8170, 8172, 8173, 8174, 8183, 8197, 8205, 8219, 8230, 8231, 8233, 8235, 8257, 8268, 8274, 8275, 8287, 8299, 8386, 8398, 8406, 8409, 8415, 8440, 8443, 8444, 8445, 8446, 8448, 8451, 8454, 8465, 8467, 8469, 8497, 8572, 8579, 8583, 8584, 8593, 8615, 8616, 8621, 8622, 8704, 8706, 8708, 8717, 8721, 8727, 8733, 8739, 8749, 8754, 8755, 8773, 8784, 8789, 8794, 8804, 8810, 8814, 8820, 8826, 10433, 10434, 10435, 10442, 10444]);
  var edgeLength = /* @__PURE__ */ new Uint8Array([3, 3, 3, 3, 3, 3, 3, 3, 5, 8, 8, 2, 2, 3, 3, 3, 3, 3, 8, 5, 5, 5, 5, 5, 3, 3, 5, 5, 9, 12, 19, 8, 19, 8, 11, 9, 9, 8, 7, 7, 6, 8, 9, 16, 10, 7, 7, 11, 8, 6, 6, 9, 7, 11, 7, 14, 4, 4, 4, 4, 4, 4, 10, 7, 6, 6, 6, 6, 10, 10, 6, 10, 10, 22, 11, 9, 10, 10, 10, 9, 10, 8, 7, 7, 7, 8, 21, 13, 11, 11, 9, 10, 9, 13, 10, 8, 8, 9, 12, 9, 7, 10, 7, 7, 13, 7, 3, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 8, 6, 3, 3, 3, 3, 3, 3, 2, 5, 3, 3, 3, 7, 2, 2, 2, 2, 2, 2, 3, 3, 3, 1, 1, 7, 8, 5, 2, 2, 7, 4, 5, 7, 2, 2, 1, 4, 1, 11, 9, 9, 5, 5, 8, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 5, 11, 9, 9, 8, 9, 9, 13, 7, 14, 7, 6, 6, 6, 7, 6, 6, 6, 6, 6, 6, 10, 7, 11, 9, 4, 4, 4, 4, 4, 6, 6, 6, 6, 13, 6, 8, 7, 10, 9, 9, 7, 9, 8, 9, 8, 7, 10, 6, 9, 8, 10, 10, 7, 8, 1, 9, 10, 12, 12, 12, 10, 9, 9, 10, 10, 9, 9, 1, 1, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6, 6, 6, 4, 3, 3, 3, 7, 4, 4, 4, 3, 3, 6, 7, 3, 4, 1, 2, 2, 2, 6, 1, 2, 2, 2, 2, 2, 12, 5, 3, 8, 9, 13, 4, 4, 13, 9, 9, 11, 7, 3, 12, 9, 2, 2, 2, 3, 3, 3, 3, 3, 8, 2, 2, 3, 3, 3, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 3, 7, 10, 15, 15, 7, 15, 20, 15, 9, 10, 10, 12, 14, 14, 14, 12, 12, 12, 12, 12, 14, 14, 10, 10, 10, 10, 14, 9, 9, 9, 9, 10, 14, 14, 14, 13, 13, 14, 9, 9, 9, 9, 9, 9, 7, 8, 6, 8, 8, 6, 8, 13, 8, 8, 6, 13, 8, 11, 13, 8, 6, 13, 8, 6, 9, 10, 10, 12, 14, 14, 14, 12, 12, 12, 12, 14, 14, 10, 10, 10, 10, 9, 9, 9, 10, 14, 14, 11, 13, 13, 9, 9, 9, 9, 9, 9, 2, 6, 9, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 2, 3, 3, 3, 3, 3, 3, 7, 7, 2, 3, 2, 2, 5, 3, 3, 3, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 5, 7, 4, 2, 2, 12, 8, 10, 8, 10, 7, 18, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 2, 2, 3, 3, 3, 5, 5, 3, 8, 8, 6, 8, 6, 6, 4, 6, 7, 7, 7, 10, 11, 2, 5, 5, 3, 3, 3, 3, 3, 3, 5, 5, 6, 11, 10, 7, 7, 7, 4, 4, 4, 2, 3, 3, 3, 3, 3, 2, 2, 7, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 7, 7, 7, 11, 7, 6, 9, 6, 6, 8, 10, 8, 6, 8, 13, 4, 4, 4, 4, 4, 10, 8, 11, 8, 8, 8, 10, 10, 7, 5, 4, 4, 10, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 7, 10, 13, 7, 8, 7, 11, 8, 8, 6, 9, 8, 8, 6, 6, 6, 8, 8, 6, 6, 6, 6, 6, 9, 7, 6, 4, 4, 4, 4, 4, 4, 4, 6, 6, 6, 9, 7, 8, 10, 8, 8, 2, 3, 3, 3, 3, 3, 2, 8, 9, 9, 2, 2, 2, 3, 3, 3, 2, 3, 3, 3, 9, 2, 2, 3, 3, 3, 3, 3, 3, 5, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 12, 5, 5, 3, 5, 4, 2, 3, 2, 4, 3, 9, 2, 2, 2, 2, 2, 5, 5, 3, 8, 8, 13, 6, 10, 9, 4, 7, 9, 11, 2, 3, 7, 3, 3, 4, 1, 3, 4, 2, 9, 3, 3, 12, 5, 3, 7, 10, 10, 7, 4, 4, 6, 14, 7, 9, 7, 13, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 8, 15, 4, 4, 2, 3, 3, 3, 7, 4, 9, 9, 2, 3, 3, 3, 5, 3, 2, 2, 7, 2, 7, 6, 6, 7, 2, 4, 2, 2, 2, 2, 2, 2, 8, 8, 8, 9, 5, 2, 3, 3, 3, 3, 3, 3, 10, 7, 4, 4, 4, 4, 3, 4, 2, 3, 3, 3, 3, 3, 10, 7, 4, 4, 4, 4, 2, 3, 3, 3, 3, 10, 7, 4, 4, 4, 4, 3, 9, 6, 6, 6, 9, 13, 9, 2, 2, 2, 8, 7, 9, 5, 3, 3, 3, 5, 5, 13, 12, 9, 10, 7, 8, 7, 6, 8, 6, 11, 12, 7, 10, 4, 4, 7, 8, 11, 6, 7, 9, 8, 7, 10, 8, 9, 15, 7, 8, 5, 4, 7, 2, 3, 3, 3, 2, 14, 10, 2, 14, 10, 2, 14, 3, 9, 13, 13, 10, 14, 16, 17, 11, 2, 14, 2, 14, 3, 9, 13, 10, 14, 16, 17, 11, 14, 10, 14, 2, 7, 3, 10, 7, 14, 10, 2, 14, 10, 9, 9, 17, 6, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 10, 10, 10, 12, 9, 4, 10, 10, 11, 8, 8, 8, 7, 9, 5, 3, 3, 3, 3, 3, 3, 3, 3, 5, 8, 4, 4, 4, 4, 4, 4, 6, 16, 3, 3, 14, 3, 14, 2, 14, 9, 13, 10, 10, 14, 16, 17, 11, 6, 9, 10, 10, 12, 14, 14, 14, 12, 12, 12, 12, 14, 14, 10, 10, 10, 10, 14, 9, 9, 9, 10, 14, 14, 14, 9, 9, 9, 9, 9, 9, 2, 14, 9, 13, 10, 10, 14, 16, 17, 11, 6, 14, 2, 14, 9, 17, 13, 10, 10, 14, 17, 16, 17, 11, 6, 2, 14, 9, 13, 10, 14, 17, 16, 17, 11, 2, 14, 9, 13, 10, 14, 16, 17, 11, 2, 14, 9, 13, 10, 17, 16, 11, 17, 2, 14, 10, 19, 7, 2, 14, 9, 13, 10, 19, 10, 7, 14, 17, 16, 17, 11, 6, 2, 14, 9, 13, 10, 19, 7, 14, 16, 17, 11, 2, 14, 9, 13, 10, 10, 14, 17, 16, 17, 11, 6, 2, 14, 9, 13, 10, 10, 14, 17, 16, 17, 11, 6, 2, 14, 9, 13, 17, 13, 10, 10, 14, 17, 16, 17, 11, 6, 3, 2, 14, 9, 13, 10, 10, 14, 16, 17, 11, 6, 9, 10, 12, 14, 14, 14, 12, 12, 12, 12, 12, 14, 14, 14, 10, 10, 10, 14, 9, 9, 9, 9, 14, 14, 14, 13, 13, 14, 9, 9, 9, 9, 9, 9, 4, 11, 2, 14, 9, 13, 17, 13, 10, 19, 10, 7, 14, 17, 16, 17, 11, 6, 2, 14, 9, 13, 17, 13, 10, 19, 10, 7, 14, 17, 16, 17, 11, 6, 2, 14, 9, 13, 10, 19, 7, 14, 17, 16, 17, 11, 2, 9, 10, 10, 7, 17, 3, 3, 12, 12, 16, 15, 15, 12, 14, 14, 14, 20, 20, 13, 12, 12, 12, 12, 12, 12, 20, 25, 14, 14, 12, 12, 10, 10, 10, 10, 14, 9, 9, 9, 25, 4, 9, 17, 10, 7, 14, 16, 21, 13, 13, 14, 20, 14, 13, 17, 24, 9, 12, 13, 25, 13, 21, 20, 17, 9, 9, 9, 9, 9, 9, 12, 17, 4, 4, 9, 9, 9, 10, 10, 12, 14, 14, 14, 12, 12, 12, 12, 12, 14, 14, 10, 10, 10, 10, 14, 9, 9, 9, 9, 10, 14, 14, 14, 13, 13, 14, 9, 9, 9, 9, 9, 9, 9, 10, 14, 12, 12, 14, 14, 10, 9, 9, 9, 10, 14, 14, 14, 9, 9, 9, 9, 2, 1, 5, 8, 7, 11, 11, 1, 3, 3, 3, 5, 3, 3, 4, 8, 9, 10, 10, 12, 14, 14, 14, 12, 12, 12, 12, 14, 14, 10, 10, 10, 10, 14, 9, 9, 9, 10, 14, 14, 14, 13, 13, 14, 9, 9, 9, 9, 9, 9, 7, 4, 4, 4, 4, 4, 4, 4, 4, 4, 10, 2, 2, 6, 7, 6, 2, 3, 2, 3, 6, 2, 7, 6, 10, 7, 4, 9, 12, 6, 14, 4, 12, 7, 2, 2, 1, 2, 7, 6, 4, 4, 4, 6, 8, 8, 7, 2, 2, 13, 2, 2, 2, 2, 6, 2, 8, 12, 2, 7, 7, 6, 8, 10, 12, 2, 2, 2, 3, 3, 13, 2, 2, 3, 3, 6, 7, 6, 4, 5, 6, 3, 3, 3, 3, 4, 16, 8, 5, 4, 3, 3, 3, 5, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 11, 12, 7, 7, 13, 9, 10, 17, 12, 8, 9, 7, 17, 17, 8, 5, 12, 10, 13, 14, 5, 5, 5, 13, 5, 5, 5, 3, 3, 3, 5, 16, 5, 5, 5, 5, 7, 12, 14, 8, 12, 8, 10, 12, 9, 11, 7, 9, 7, 10, 7, 13, 13, 9, 7, 12, 8, 17, 7, 7, 16, 10, 13, 13, 8, 10, 10, 14, 17, 7, 16, 16, 15, 8, 10, 10, 12, 17, 17, 7, 17, 14, 7, 10, 17, 8, 7, 7, 7, 8, 15, 15, 7, 14, 10, 10, 10, 11, 11, 7, 7, 13, 8, 10, 7, 16, 7, 8, 7, 14, 17, 12, 10, 11, 21, 8, 9, 7, 13, 9, 8, 6, 13, 6, 12, 7, 6, 13, 10, 10, 10, 8, 18, 9, 17, 13, 10, 12, 6, 13, 6, 11, 8, 13, 10, 13, 18, 13, 11, 13, 8, 16, 7, 10, 8, 16, 12, 10, 8, 8, 14, 11, 8, 15, 8, 8, 7, 7, 12, 7, 8, 9, 14, 15, 8, 9, 10, 9, 15, 7, 8, 8, 12, 13, 9, 10, 15, 13, 7, 10, 10, 20, 7, 6, 9, 6, 6, 14, 11, 14, 11, 12, 9, 10, 16, 16, 12, 7, 11, 28, 8, 11, 10, 7, 21, 8, 7, 9, 4, 4, 4, 17, 7, 8, 6, 9, 6, 6, 13, 6, 6, 6, 6, 18, 20, 14, 8, 11, 12, 9, 10, 13, 15, 15, 19, 8, 9, 12, 7, 10, 16, 12, 9, 9, 9, 14, 12, 11, 10, 9, 12, 11, 18, 9, 9, 9, 10, 7, 7, 16, 8, 9, 7, 13, 12, 10, 14, 18, 7, 8, 11, 7, 7, 8, 8, 13, 7, 7, 7, 11, 15, 13, 11, 7, 8, 15, 11, 7, 8, 18, 14, 13, 18, 15, 10, 12, 12, 9, 7, 11, 11, 8, 7, 10, 8, 14, 12, 10, 18, 7, 10, 9, 7, 8, 13, 10, 14, 10, 8, 8, 23, 7, 7, 11, 12, 12, 17, 7, 7, 11, 11, 17, 16, 16, 7, 8, 11, 14, 14, 8, 10, 7, 7, 16, 16, 13, 9, 11, 9, 15, 15, 11, 11, 7, 7, 14, 7, 9, 7, 7, 16, 10, 13, 10, 11, 14, 7, 11, 10, 11, 7, 11, 10, 11, 15, 11, 15, 10, 12, 10, 14, 13, 11, 11, 12, 13, 10, 7, 13, 16, 12, 21, 15, 9, 10, 10, 7, 11, 14, 17, 7, 7, 8, 11, 13, 12, 8, 15, 14, 14, 8, 17, 12, 10, 10, 7, 9, 11, 7, 10, 7, 11, 18, 7, 11, 7, 12, 11, 8, 8, 14, 12, 7, 8, 15, 3, 7, 7, 5, 2, 9, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 2, 5, 3, 3, 3, 3, 3, 3, 4, 4, 3, 3, 3, 3, 3, 3, 5, 11, 6, 4, 7, 10, 7, 7, 11, 1, 10, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 5, 7, 3, 5, 6, 3, 3, 5, 2, 2, 5, 3, 4, 13, 11, 3, 3, 6, 3, 5, 14, 2, 2, 3, 8, 2, 2, 12, 5, 18, 5, 3, 3, 3, 3, 16, 5, 5, 5, 10, 7, 13, 12, 13, 9, 12, 14, 19, 9, 9, 21, 9, 9, 10, 6, 9, 6, 15, 10, 6, 12, 8, 6, 10, 15, 4, 4, 6, 6, 9, 9, 12, 16, 14, 23, 7, 7, 7, 14, 9, 7, 7, 11, 14, 10, 7, 10, 10, 10, 12, 6, 11, 10, 13, 11, 15, 11, 7, 12, 10, 3, 7, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 4, 3, 7, 1, 5, 2, 2, 2, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 5, 5, 10, 9, 11, 8, 7, 12, 8, 9, 7, 6, 13, 11, 6, 13, 7, 9, 9, 4, 4, 4, 4, 4, 6, 10, 7, 8, 13, 8, 8, 9, 14, 7, 8, 10, 7, 9, 7, 7, 9, 6, 9, 7, 2, 12, 5, 3, 3, 13, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 8, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 9, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 2, 2, 2, 5, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 1, 7, 6, 4, 12, 3, 3, 3, 3, 3, 8, 7, 3, 3, 3, 3, 3, 3, 4, 4, 11, 15, 14, 2, 8, 3, 5, 5, 8, 10, 8, 6, 4, 7, 17, 7, 4, 5, 2, 6, 3, 2, 2, 12, 5, 5, 3, 15, 13, 8, 11, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 5, 3, 3, 3, 3, 4, 18, 2, 12, 5, 3, 3, 3, 3, 3, 5, 16, 8, 8, 9, 6, 6, 4, 4, 4, 4, 31, 6, 6, 10, 11, 21, 10, 9, 7, 10, 7, 7, 2, 4, 4, 4, 4, 6, 5, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6, 6, 6, 2, 2, 2, 5, 3, 3, 3, 7, 7, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 3, 3, 3, 3, 8, 2, 3, 3, 3, 3, 3, 5, 9, 11, 3, 3, 3, 3, 4, 4, 3, 3, 3, 3, 3, 5, 10, 9, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 11, 10, 10, 10, 10, 10, 11, 10, 11, 10, 11, 10, 9, 9, 11, 3, 3, 3, 3, 3, 3, 5, 3, 7, 8, 8, 7, 6, 6, 11, 4, 4, 4, 7, 8, 9, 9, 2, 3, 7, 4, 4, 2, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 2, 2, 5, 5, 5, 5, 5, 3, 3, 5, 5, 5, 7, 7, 6, 6, 6, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 8, 8, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 6, 9, 12, 3, 7, 10, 7, 2, 2, 3, 3, 3, 3, 3, 4, 3, 3, 2, 2, 2, 2, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 8, 8, 6, 6, 8, 6, 7, 4, 4, 4, 4, 4, 4, 6, 7, 5, 5, 20, 19, 8, 10, 9, 7, 10, 6, 8, 11, 6, 6, 6, 6, 13, 12, 8, 6, 7, 14, 11, 9, 2, 5, 3, 6, 2, 3, 2, 2, 2, 2, 2, 2, 2, 5, 4, 3, 7, 6, 4, 7, 4, 3, 6, 4, 7, 2, 7, 7, 7, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 9, 10, 10, 11, 7, 8, 20, 7, 8, 9, 8, 12, 6, 6, 6, 8, 9, 8, 12, 6, 6, 8, 13, 10, 12, 6, 6, 7, 7, 9, 6, 4, 4, 4, 4, 4, 4, 10, 6, 6, 6, 7, 14, 11, 10, 7, 8, 10, 8, 11, 14, 11, 11, 9, 7, 9, 8, 11, 9, 17, 10, 9, 2, 2, 2, 9, 3, 3, 3, 3, 15, 14, 9, 5, 5, 2, 8, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 15, 12, 22, 19, 17, 18, 18, 19, 21, 7, 16, 16, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 9, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 7, 16, 11, 11, 7, 7, 7, 7, 17, 7, 8, 12, 15, 9, 19, 7, 19, 8, 21, 11, 12, 19, 14, 22, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 16, 16, 19, 24, 12, 7, 14, 7, 12, 7, 8, 10, 10, 13, 7, 12, 12, 7, 7, 10, 18, 15, 12, 16, 7, 14, 12, 17, 10, 16, 17, 12, 17, 25, 7, 7, 7, 13, 6, 9, 6, 9, 18, 6, 6, 11, 20, 10, 6, 6, 6, 6, 6, 6, 17, 6, 6, 6, 15, 6, 6, 6, 6, 6, 8, 14, 11, 12, 11, 15, 13, 19, 17, 21, 7, 18, 8, 13, 13, 8, 12, 8, 6, 6, 13, 6, 15, 15, 16, 6, 6, 16, 6, 6, 6, 14, 6, 18, 6, 6, 6, 17, 18, 9, 13, 15, 8, 19, 8, 15, 15, 18, 14, 16, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 11, 10, 11, 6, 21, 23, 12, 17, 12, 11, 14, 13, 22, 15, 15, 11, 12, 14, 12, 7, 12, 8, 12, 14, 12, 18, 10, 8, 16, 19, 17, 12, 14, 15, 8, 19, 17, 12, 13, 13, 15, 18, 13, 23, 24, 23, 21, 17, 24, 8, 21, 8, 14, 14, 16, 20, 14, 8, 8, 15, 20, 8, 19, 21, 9, 8, 13, 12, 13, 15, 11, 8, 11, 9, 9, 8, 11, 8, 21, 14, 21, 15, 15, 13, 7, 19, 7, 7, 7, 7, 7, 7, 16, 12, 17, 18, 7, 7, 11, 11, 7, 9, 9, 2, 2, 3, 3, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 10, 10, 7, 9, 7, 7, 7, 6, 8, 6, 6, 6, 6, 6, 6, 6, 7, 6, 8, 6, 6, 9, 7, 7, 7, 4, 4, 4, 4, 4, 4, 4, 4, 8, 9, 8, 7, 8, 7, 8, 10, 7, 5, 5, 5, 5, 5, 5, 3, 9, 7, 7, 8, 6, 6, 6, 6, 6, 6, 6, 6, 9, 6, 6, 9, 11, 13, 7, 8, 9, 9, 5, 5, 5, 7, 8, 6, 6, 6, 6, 6, 6, 6, 7, 8, 9, 7, 10, 9, 10, 7, 8, 5, 5, 5, 5, 5, 5, 7, 7, 9, 8, 7, 7, 6, 6, 6, 6, 6, 6, 10, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 9, 10, 4, 4, 4, 4, 8, 7, 7, 10, 10, 9, 8, 8, 15, 9, 8, 8, 8, 8, 8, 9, 10, 9, 10, 7, 8, 13, 5, 5, 5, 5, 5, 3, 3, 7, 7, 8, 6, 6, 6, 4, 4, 11, 9, 7, 8, 9, 10, 7, 5, 5, 5, 5, 5, 3, 3, 7, 6, 6, 13, 7, 9, 8, 7, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 7, 8, 7, 8, 13, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8, 6, 6, 6, 6, 7, 6, 7, 6, 6, 9, 7, 4, 4, 4, 4, 4, 4, 4, 7, 8, 7, 8, 9, 8, 8, 8, 7, 10, 7, 8, 5, 5, 5, 5, 5, 5, 5, 5, 3, 7, 7, 7, 7, 9, 7, 10, 9, 6, 6, 6, 6, 6, 8, 8, 6, 6, 6, 7, 6, 6, 6, 9, 9, 4, 4, 13, 7, 10, 9, 9, 12, 7, 8, 8, 10, 8, 8, 8, 8, 8, 8, 5, 5, 5, 5, 3, 7, 7, 11, 7, 9, 8, 8, 6, 6, 10, 6, 8, 8, 8, 6, 7, 6, 6, 12, 4, 4, 4, 4, 4, 4, 4, 4, 4, 9, 8, 8, 16, 8, 9, 8, 7, 5, 5, 5, 5, 5, 3, 3, 7, 7, 7, 10, 15, 8, 9, 8, 9, 9, 6, 6, 6, 6, 6, 6, 7, 4, 8, 7, 8, 8, 7, 8, 11, 8, 5, 5, 5, 5, 5, 3, 7, 7, 6, 11, 16, 7, 6, 4, 4, 4, 4, 9, 9, 8, 8, 8, 13, 12, 8, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 11, 7, 8, 8, 9, 13, 7, 7, 7, 9, 8, 8, 9, 12, 7, 12, 7, 12, 8, 7, 10, 12, 9, 9, 6, 6, 8, 8, 6, 6, 6, 6, 6, 6, 6, 9, 8, 9, 11, 8, 6, 6, 6, 6, 6, 12, 7, 6, 6, 6, 9, 7, 7, 6, 6, 6, 6, 6, 11, 9, 6, 6, 6, 6, 6, 7, 9, 4, 4, 4, 4, 4, 4, 4, 4, 9, 9, 9, 9, 7, 7, 7, 7, 7, 11, 7, 7, 8, 8, 8, 8, 8, 8, 9, 8, 9, 9, 7, 7, 11, 11, 7, 12, 8, 8, 8, 8, 8, 7, 8, 8, 8, 8, 8, 13, 12, 8, 8, 8, 8, 7, 7, 7, 9, 5, 5, 5, 5, 5, 5, 5, 3, 3, 7, 7, 11, 7, 8, 8, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 10, 11, 6, 7, 9, 4, 4, 4, 4, 4, 4, 9, 9, 8, 9, 8, 8, 8, 7, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 11, 7, 7, 7, 9, 6, 6, 11, 8, 10, 6, 6, 6, 12, 8, 8, 7, 6, 6, 8, 7, 4, 4, 4, 4, 4, 4, 4, 4, 9, 10, 9, 9, 8, 10, 9, 11, 8, 5, 5, 5, 7, 6, 6, 8, 7, 4, 4, 4, 4, 8, 7, 7, 8, 7, 8, 8, 5, 5, 5, 5, 7, 7, 8, 8, 8, 6, 6, 6, 6, 6, 10, 8, 9, 13, 6, 7, 6, 6, 8, 7, 8, 4, 4, 4, 4, 11, 8, 8, 8, 10, 5, 5, 8, 7, 8, 13, 8, 7, 6, 8, 6, 9, 7, 8, 7, 5, 5, 5, 5, 5, 5, 3, 3, 7, 8, 9, 6, 4, 8, 10, 10, 8, 12, 9, 13, 2, 7, 5, 5, 5, 5, 5, 7, 7, 10, 6, 6, 6, 6, 6, 6, 6, 8, 4, 4, 9, 8, 8, 8, 14, 8, 8, 8, 9, 8, 5, 5, 5, 5, 5, 3, 3, 9, 6, 6, 6, 6, 10, 12, 6, 6, 6, 6, 6, 6, 6, 4, 4, 4, 4, 11, 8, 7, 8, 8, 8, 5, 5, 3, 3, 3, 3, 7, 7, 6, 8, 6, 8, 11, 7, 6, 6, 6, 7, 4, 8, 11, 9, 10, 5, 5, 5, 3, 3, 3, 7, 7, 8, 9, 8, 15, 9, 6, 6, 6, 6, 6, 6, 11, 11, 4, 4, 4, 4, 4, 7, 9, 9, 10, 8, 7, 5, 5, 5, 5, 5, 5, 3, 3, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 9, 7, 4, 4, 4, 4, 4, 9, 9, 8, 8, 10, 13, 5, 5, 5, 3, 17, 7, 7, 7, 7, 7, 8, 6, 8, 13, 6, 6, 6, 6, 6, 6, 6, 6, 4, 4, 4, 9, 10, 8, 8, 8, 5, 5, 5, 5, 3, 7, 7, 7, 8, 8, 6, 6, 6, 8, 8, 8, 9, 10, 8, 4, 8, 10, 9, 8, 8, 8, 9, 13, 10, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 7, 8, 9, 9, 7, 7, 7, 10, 9, 9, 8, 9, 8, 8, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 8, 12, 6, 6, 6, 6, 6, 6, 6, 6, 6, 12, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 11, 8, 8, 9, 9, 10, 8, 9, 7, 7, 5, 5, 5, 5, 5, 5, 3, 7, 8, 7, 6, 6, 8, 6, 6, 10, 4, 7, 8, 9, 12, 8, 7, 7, 5, 5, 5, 5, 5, 5, 3, 3, 7, 14, 7, 9, 8, 8, 6, 6, 8, 12, 12, 6, 6, 7, 7, 10, 4, 4, 4, 4, 4, 9, 9, 14, 9, 13, 8, 7, 5, 5, 5, 6, 6, 6, 7, 4, 8, 7, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 7, 7, 7, 8, 6, 6, 6, 6, 6, 6, 12, 6, 6, 6, 6, 4, 4, 9, 9, 8, 8, 11, 7, 7, 7, 5, 5, 5, 3, 9, 8, 6, 6, 7, 4, 4, 4, 4, 4, 4, 8, 8, 11, 5, 5, 5, 7, 7, 7, 9, 6, 6, 6, 6, 6, 6, 9, 8, 4, 4, 4, 4, 7, 12, 9, 8, 8, 8, 7, 10, 10, 5, 5, 5, 5, 5, 5, 5, 3, 11, 14, 8, 7, 8, 8, 6, 6, 6, 6, 6, 8, 7, 6, 6, 6, 7, 6, 8, 9, 4, 4, 4, 7, 8, 9, 7, 9, 7, 7, 9, 8, 5, 5, 5, 5, 5, 5, 5, 5, 5, 11, 3, 9, 7, 7, 12, 14, 8, 6, 6, 12, 11, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 15, 7, 4, 4, 4, 16, 9, 9, 9, 8, 9, 9, 9, 9, 9, 8, 8, 8, 13, 11, 8, 5, 5, 5, 5, 3, 7, 6, 6, 8, 8, 8, 6, 6, 7, 10, 7, 4, 4, 4, 4, 9, 7, 8, 7, 7, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 7, 7, 7, 9, 6, 6, 6, 6, 6, 8, 8, 7, 7, 9, 6, 6, 6, 7, 6, 6, 6, 6, 6, 15, 4, 4, 4, 4, 4, 8, 8, 7, 8, 12, 9, 8, 8, 8, 8, 8, 9, 8, 8, 10, 8, 8, 8, 8, 16, 9, 10, 2, 5, 5, 5, 5, 5, 5, 5, 9, 7, 6, 8, 9, 4, 4, 4, 4, 4, 7, 8, 8, 8, 9, 8, 11, 10, 5, 5, 5, 5, 3, 7, 8, 6, 6, 6, 6, 6, 8, 6, 6, 6, 6, 4, 12, 10, 12, 7, 7, 7, 7, 7, 7, 7, 5, 5, 5, 5, 3, 3, 7, 7, 10, 8, 9, 7, 6, 10, 7, 6, 6, 4, 4, 8, 9, 7, 9, 9, 9, 9, 8, 8, 8, 8, 10, 5, 5, 5, 5, 5, 5, 8, 7, 6, 6, 6, 10, 6, 7, 10, 7, 4, 4, 4, 4, 4, 4, 4, 12, 9, 10, 7, 7, 10, 8, 10, 5, 12, 9, 6, 6, 6, 6, 6, 7, 6, 4, 4, 4, 10, 9, 9, 8, 7, 7, 5, 5, 5, 5, 5, 5, 3, 3, 13, 7, 7, 9, 7, 7, 7, 8, 9, 9, 7, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 13, 9, 15, 15, 4, 4, 4, 4, 4, 10, 10, 9, 8, 9, 8, 8, 9, 7, 8, 7, 8, 5, 5, 7, 6, 6, 6, 4, 4, 4, 7, 8, 11, 8, 5, 5, 5, 5, 5, 5, 5, 7, 6, 6, 6, 6, 6, 6, 9, 11, 10, 7, 4, 4, 4, 9, 8, 8, 5, 5, 5, 5, 5, 9, 9, 6, 6, 6, 6, 6, 6, 6, 9, 9, 4, 4, 4, 4, 8, 8, 8, 9, 9, 8, 8, 8, 13, 2, 4, 2, 7, 5, 5, 5, 5, 5, 5, 9, 9, 6, 6, 6, 6, 10, 8, 8, 8, 6, 6, 6, 4, 4, 9, 8, 10, 8, 9, 8, 8, 8, 9, 8, 8, 5, 3, 3, 3, 11, 6, 6, 6, 7, 6, 6, 6, 4, 4, 9, 8, 5, 5, 5, 5, 5, 3, 11, 8, 6, 6, 6, 6, 6, 9, 7, 4, 4, 14, 10, 9, 8, 12, 8, 8, 8, 11, 15, 8, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 11, 11, 11, 10, 10, 7, 7, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 7, 11, 7, 7, 11, 11, 7, 8, 9, 10, 7, 7, 9, 9, 9, 9, 7, 7, 10, 8, 13, 8, 8, 8, 8, 11, 10, 6, 6, 8, 10, 11, 14, 14, 6, 6, 6, 6, 6, 6, 9, 11, 7, 7, 6, 8, 12, 11, 11, 6, 6, 10, 6, 6, 6, 6, 6, 10, 7, 7, 6, 6, 11, 6, 6, 6, 11, 8, 9, 7, 6, 10, 11, 9, 10, 11, 7, 11, 8, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 6, 6, 8, 9, 10, 9, 6, 6, 6, 10, 6, 6, 6, 6, 11, 10, 11, 10, 9, 8, 7, 7, 7, 7, 11, 14, 8, 10, 9, 9, 8, 8, 7, 11, 8, 8, 8, 11, 11, 10, 10, 9, 10, 8, 11, 10, 8, 11, 9, 12, 8, 10, 8, 11, 8, 9, 9, 11, 11, 10, 11, 13, 8, 7, 8, 8, 9, 7, 8, 8, 8, 8, 7, 8, 2, 2, 2, 2, 2, 2, 2, 4, 4, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3, 8, 6, 4, 4, 4, 11, 7, 11, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 5, 5, 5, 5, 3, 3, 3, 3, 8, 7, 7, 8, 8, 4, 8, 7, 7, 7, 9, 7, 8, 9, 8, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6, 3, 3, 3, 3, 3, 3, 3, 3, 4, 2, 2, 3, 3, 3, 3, 3, 3, 4, 5, 5, 3, 3, 8, 8, 6, 9, 4, 4, 10, 7, 3, 3, 3, 2, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 3, 2, 2, 2, 3, 3, 3, 3, 3, 4, 10, 2, 3, 3, 3, 3, 3, 3, 3, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 3, 3, 3, 5, 2, 4, 2, 6, 2, 2, 9, 5, 5, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 9, 8, 7, 9, 6, 6, 11, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 7, 7, 11, 8, 8, 6, 5, 11, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 2, 2, 3, 3, 3, 3, 3, 3, 6, 4, 4, 4, 4, 3, 3, 3, 3, 5, 7, 2, 3, 3, 3, 3, 3, 8, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6, 4, 4, 4, 4, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 2, 2, 3, 3, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 6, 3, 3, 8, 10, 3, 4, 4, 1, 1, 1, 1, 1, 1, 1, 8, 9, 10, 7, 7, 1, 14, 18, 13, 18, 13, 10, 10, 16, 13, 18, 16, 13, 16, 18, 13, 22, 16, 16, 16, 14, 21, 16, 9, 14, 16, 9, 9, 14, 10, 10, 14, 12, 14, 19, 12, 11, 18, 13, 17, 15, 15, 15, 15, 16, 14, 13, 19, 18, 15, 19, 18, 12, 18, 12, 11, 20, 14, 15, 10, 17, 17, 16, 19, 20, 21, 15, 13, 16, 15, 15, 15, 1, 1, 3, 8, 7, 7, 8, 8, 8, 1, 6, 1, 1, 6, 3, 3, 4, 7, 3, 3, 5, 5, 4, 4, 4, 4, 4, 2, 7, 7, 8, 12, 3, 4, 5, 1, 3, 4, 4, 10, 4, 3, 3, 3, 8, 7, 7, 2, 2, 2, 2, 2, 2, 2, 2, 2, 12, 9, 20, 7, 5, 5, 5, 9, 13, 5, 5, 5, 5, 5, 3, 3, 3, 16, 5, 5, 5, 13, 7, 8, 8, 11, 8, 7, 9, 7, 11, 12, 9, 9, 8, 8, 11, 10, 14, 7, 12, 10, 11, 13, 7, 9, 11, 17, 17, 14, 13, 7, 8, 7, 10, 10, 7, 16, 13, 7, 8, 17, 12, 9, 8, 6, 7, 10, 6, 6, 12, 6, 8, 10, 8, 8, 8, 6, 8, 6, 14, 6, 6, 6, 13, 6, 10, 6, 6, 7, 14, 8, 6, 6, 10, 11, 10, 9, 9, 7, 7, 6, 6, 6, 9, 9, 7, 9, 10, 9, 13, 12, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 6, 8, 8, 6, 8, 9, 10, 9, 7, 10, 10, 8, 7, 8, 7, 10, 12, 9, 8, 15, 8, 7, 8, 8, 7, 7, 15, 13, 7, 10, 9, 14, 18, 16, 7, 24, 7, 8, 10, 11, 16, 8, 14, 7, 9, 9, 9, 13, 19, 14, 15, 14, 11, 7, 13, 9, 10, 7, 13, 9, 10, 11, 12, 8, 9, 2, 3, 5, 8, 7, 4, 4, 15, 10, 5, 3, 3, 3, 3, 3, 5, 4, 4, 4, 2, 2, 2, 2, 2, 1, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 2, 12, 5, 3, 8, 10, 15, 6, 7, 2, 3, 2, 5, 5, 12, 2, 5, 5, 5, 5, 2, 2, 5, 5, 12, 9, 5, 2, 2, 9, 5, 5, 12, 12, 5, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 9, 12, 5, 8, 8, 9, 5, 5, 5, 8, 19, 7, 16, 15, 14, 9, 9, 9, 9, 7, 11, 11, 11, 7, 14, 10, 10, 5, 5, 5, 5, 5, 5, 5, 5, 5, 15, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 9, 9, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 14, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 15, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 12, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 9, 9, 12, 9, 9, 12, 12, 12, 15, 7, 11, 7, 14, 11, 18, 13, 8, 18, 15, 18, 12, 14, 12, 8, 8, 8, 8, 9, 9, 9, 12, 7, 10, 10, 8, 8, 12, 12, 12, 7, 12, 12, 9, 7, 7, 7, 7, 7, 8, 15, 12, 9, 10, 10, 7, 10, 10, 13, 11, 10, 9, 22, 11, 9, 8, 8, 8, 8, 8, 13, 18, 13, 9, 15, 19, 9, 7, 7, 10, 7, 7, 7, 11, 8, 13, 17, 7, 7, 10, 10, 10, 7, 20, 16, 7, 7, 7, 7, 7, 7, 11, 21, 12, 12, 13, 11, 14, 16, 8, 8, 13, 11, 7, 7, 13, 7, 7, 14, 15, 15, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 13, 10, 18, 6, 6, 6, 6, 6, 6, 6, 6, 6, 11, 8, 8, 12, 12, 11, 11, 8, 12, 9, 9, 9, 13, 13, 9, 9, 9, 9, 9, 9, 6, 10, 12, 6, 6, 6, 6, 17, 11, 7, 7, 7, 7, 14, 14, 12, 6, 7, 7, 6, 6, 15, 10, 13, 10, 6, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 13, 9, 9, 15, 13, 6, 12, 12, 6, 19, 11, 10, 7, 7, 16, 8, 19, 17, 9, 9, 9, 9, 9, 6, 6, 6, 10, 8, 16, 8, 6, 6, 9, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8, 8, 6, 7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 14, 6, 6, 6, 6, 20, 6, 9, 6, 14, 9, 9, 9, 6, 9, 8, 8, 12, 9, 8, 8, 8, 8, 7, 8, 12, 7, 8, 8, 8, 6, 8, 6, 6, 6, 6, 6, 6, 6, 9, 8, 8, 6, 6, 13, 9, 12, 13, 12, 14, 13, 12, 11, 11, 6, 8, 8, 8, 6, 13, 12, 11, 11, 12, 6, 11, 12, 11, 13, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 15, 6, 6, 6, 6, 6, 6, 6, 13, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8, 8, 8, 6, 18, 6, 12, 13, 13, 13, 9, 10, 15, 9, 12, 6, 6, 6, 6, 6, 6, 6, 6, 9, 15, 10, 9, 10, 13, 9, 19, 8, 18, 17, 10, 10, 8, 8, 6, 6, 6, 6, 6, 6, 10, 14, 8, 16, 16, 9, 8, 15, 8, 8, 10, 12, 14, 7, 7, 8, 8, 7, 7, 7, 7, 8, 13, 13, 11, 9, 9, 9, 12, 10, 17, 8, 11, 9, 7, 7, 14, 8, 14, 14, 7, 7, 7, 7, 7, 7, 14, 7, 7, 7, 7, 7, 10, 10, 8, 14, 7, 7, 7, 7, 8, 8, 8, 8, 8, 17, 9, 7, 15, 7, 8, 12, 7, 9, 14, 7, 7, 7, 9, 13, 8, 14, 7, 16, 18, 13, 15, 14, 12, 13, 10, 15, 9, 7, 7, 7, 10, 13, 15, 15, 9, 9, 9, 9, 19, 11, 7, 11, 11, 13, 8, 8, 8, 8, 7, 12, 19, 17, 9, 9, 13, 7, 7, 7, 9, 7, 7, 7, 12, 13, 15, 10, 8, 8, 14, 15, 12, 13, 13, 8, 12, 14, 7, 11, 7, 14, 15, 13, 12, 8, 8, 8, 8, 11, 13, 15, 15, 8, 13, 12, 8, 8, 8, 13, 10, 16, 14, 11, 8, 8, 12, 12, 9, 15, 15, 12, 12, 13, 8, 8, 9, 12, 13, 9, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 11, 12, 11, 7, 14, 7, 13, 13, 13, 12, 18, 16, 7, 12, 11, 10, 10, 15, 9, 9, 9, 21, 7, 7, 7, 11, 16, 8, 8, 11, 11, 7, 7, 7, 7, 7, 19, 7, 7, 7, 7, 7, 7, 7, 7, 7, 12, 8, 9, 12, 14, 11, 9, 9, 9, 22, 12, 3, 3, 4, 8, 8, 15, 4, 2, 2, 5, 5, 3, 3, 3, 3, 3, 3, 6, 6, 4, 4, 4, 12, 7, 10, 2, 3, 3, 3, 3, 3, 3, 3, 6, 7, 3, 7, 5, 14, 4, 4, 7, 8, 10, 4, 1, 3, 3, 6, 2, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 2, 2, 5, 3, 4, 2, 2, 2, 2, 2, 2, 11, 5, 5, 5, 11, 5, 5, 3, 5, 5, 5, 5, 11, 14, 13, 9, 11, 9, 12, 8, 11, 11, 8, 11, 16, 9, 9, 7, 10, 9, 12, 8, 15, 6, 7, 6, 6, 13, 10, 8, 11, 8, 6, 6, 6, 12, 16, 6, 11, 7, 8, 9, 18, 6, 6, 9, 4, 4, 6, 13, 6, 6, 6, 6, 8, 8, 9, 16, 7, 7, 14, 7, 8, 8, 8, 7, 7, 7, 7, 7, 7, 15, 13, 7, 10, 7, 7, 10, 12, 16, 15, 7, 9, 9, 14, 11, 11, 10, 9, 10, 8, 12, 7, 8, 7, 7, 10, 12, 7, 12, 8, 7, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 3, 3, 5, 5, 5, 10, 7, 4, 4, 8, 7, 10, 9, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 3, 3, 3, 3, 3, 3, 3, 7, 4, 5, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 6, 6, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 9, 8, 2, 2, 2, 8, 12, 7, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 8, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 7, 11, 9, 8, 8, 8, 7, 8, 9, 7, 7, 9, 7, 7, 7, 10, 7, 7, 10, 9, 10, 6, 6, 6, 6, 6, 6, 15, 7, 8, 9, 9, 8, 6, 6, 10, 9, 6, 8, 13, 9, 7, 6, 6, 6, 6, 6, 6, 12, 6, 6, 7, 6, 7, 6, 6, 6, 10, 10, 7, 6, 6, 6, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 14, 6, 6, 7, 7, 9, 6, 6, 6, 6, 9, 9, 8, 9, 10, 9, 8, 9, 12, 7, 7, 7, 8, 7, 10, 12, 11, 9, 10, 7, 7, 7, 9, 10, 10, 8, 12, 9, 7, 7, 9, 8, 8, 8, 10, 7, 7, 8, 9, 9, 7, 7, 7, 8, 2, 4, 2, 4, 6, 3, 4, 2, 3, 3, 3, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 5, 8, 6, 4, 7, 3, 3, 3, 3, 3, 3, 3, 12, 3, 3, 3, 3, 3, 3, 4, 4, 2, 3, 5, 3, 4, 7, 3, 3, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 4, 3, 3, 6, 4, 3, 4, 2, 2, 2, 5, 3, 3, 3, 3, 3, 5, 4, 4, 4, 4, 7, 6, 8, 9, 2, 2, 2, 2, 3, 3, 3, 5, 7, 2, 3, 3, 8, 7, 7, 2, 2, 8, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 8, 8, 7, 7, 6, 10, 6, 9, 7, 11, 4, 6, 8, 8, 7, 8, 4, 5, 5, 5, 5, 3, 3, 3, 11, 8, 9, 6, 6, 8, 7, 4, 4, 7, 6, 8, 7, 2, 2, 3, 3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 7, 2, 2, 5, 3, 3, 2, 3, 3, 3, 3, 3, 3, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 12, 5, 5, 3, 3, 3, 5, 10, 12, 6, 15, 4, 6, 6, 7, 14, 9, 3, 3, 3, 3, 3, 8, 2, 2, 3, 5, 5, 3, 3, 3, 3, 3, 3, 8, 8, 8, 7, 5, 8, 4, 6, 11, 2, 2, 7, 3, 3, 2, 9, 8, 5, 5, 3, 3, 3, 5, 5, 7, 7, 6, 6, 10, 6, 8, 6, 8, 9, 7, 4, 4, 4, 4, 7, 6, 6, 7, 7, 10, 9, 9, 8, 11, 8, 3, 3, 3, 3, 3, 4, 4, 2, 3, 3, 3, 3, 3, 7, 6, 2, 5, 5, 6, 7, 6, 4, 8, 9, 11, 2, 2, 3, 3, 3, 3, 3, 3, 3, 2, 2, 5, 3, 3, 3, 3, 3, 9, 9, 6, 4, 8, 7, 7, 5, 9, 8, 6, 2, 6, 8, 7, 8, 5, 5, 5, 5, 5, 3, 3, 3, 16, 8, 7, 7, 7, 8, 7, 7, 7, 7, 9, 6, 9, 6, 10, 7, 7, 7, 6, 10, 8, 9, 11, 11, 8, 4, 4, 10, 8, 8, 6, 9, 6, 11, 8, 8, 8, 15, 7, 8, 9, 5, 3, 3, 3, 3, 3, 5, 2, 2, 3, 8, 9, 10, 3, 2, 2, 2, 2, 2, 2, 3, 6, 4, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 2, 3, 3, 3, 3, 3, 3, 3, 11, 5, 3, 3, 3, 3, 3, 3, 3, 3, 6, 7, 4, 4, 2, 3, 3, 3, 3, 3, 3, 3, 12, 7, 4, 12, 4, 6, 5, 4, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 11, 10, 6, 4, 6, 10, 8, 3, 3, 3, 3, 3, 3, 3, 3, 5, 4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 5, 3, 4, 4, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 10, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 7, 8, 8, 7, 13, 12, 10, 10, 8, 8, 7, 7, 9, 12, 11, 6, 6, 8, 8, 9, 7, 7, 7, 10, 15, 10, 4, 4, 4, 4, 4, 11, 8, 8, 9, 7, 9, 14, 14, 12, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 12, 5, 5, 5, 11, 10, 7, 9, 3, 8, 7, 3, 15, 13, 11, 4, 4, 2, 2, 2, 19, 7, 5, 5, 3, 3, 3, 3, 3, 3, 3, 5, 22, 18, 6, 14, 17, 4, 4, 19, 16, 18, 2, 3, 3, 7, 2, 3, 2, 3, 3, 6, 4, 2, 3, 3, 2, 5, 3, 3, 3, 3, 3, 3, 3, 9, 9, 2, 3, 2, 2, 2, 3, 3, 3, 5, 7, 14, 7, 7, 12, 9, 13, 6, 11, 6, 10, 9, 7, 7, 8, 12, 12, 8, 8, 8, 10, 7, 7, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 5, 8, 10, 7, 8, 11, 8, 12, 9, 4, 14, 7, 7, 9, 13, 2, 3, 3, 3, 3, 3, 3, 2, 3, 3, 3, 1, 2, 2, 3, 3, 3, 3, 3, 3, 5, 2, 2, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 8, 4, 4, 4, 3, 2, 3, 3, 3, 3, 5, 2, 2, 2, 2, 2, 2, 2, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 12, 9, 8, 8, 9, 8, 6, 17, 6, 6, 6, 8, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 4, 4, 8, 8, 9, 9, 9, 7, 7, 7, 7, 7, 7, 7, 9, 9, 9, 7, 8, 8, 8, 10, 7, 13, 10, 8, 9, 3, 3, 5, 13, 3, 3, 3, 3, 3, 7, 7, 6, 6, 10, 13, 11, 11, 8, 8, 9, 8, 9, 9, 10, 10, 10, 11, 10, 10, 13, 13, 16, 15, 11, 12, 9, 9, 10, 9, 11, 10, 9, 9, 14, 7, 8, 3, 10, 7, 7, 3, 2, 2, 2, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6, 7, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 11, 6, 7, 4, 6, 2, 2, 3, 3, 3, 1, 3, 3, 3, 3, 3, 3, 6, 4, 4, 2, 2, 2, 3, 3, 3, 3, 4, 4, 6, 6, 6, 6, 5, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 9, 11, 6, 10, 9, 12, 7, 7, 11, 14, 9, 7, 12, 3, 3, 7, 12, 11, 12, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 9, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 11, 5, 5, 5, 5, 5, 5, 5, 5, 11, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 3, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 3, 10, 3, 3, 3, 11, 3, 5, 9, 11, 8, 12, 14, 9, 7, 8, 7, 7, 11, 11, 7, 7, 10, 9, 8, 10, 9, 7, 7, 7, 7, 7, 7, 8, 8, 7, 11, 8, 8, 8, 7, 7, 10, 8, 7, 13, 12, 7, 17, 10, 8, 8, 11, 7, 11, 11, 14, 7, 11, 7, 8, 6, 9, 20, 8, 7, 9, 16, 7, 10, 6, 11, 10, 8, 9, 7, 16, 11, 11, 9, 8, 9, 8, 8, 8, 11, 8, 15, 8, 8, 9, 7, 8, 8, 11, 10, 7, 5, 7, 10, 10, 15, 7, 7, 7, 8, 7, 8, 8, 10, 11, 10, 10, 10, 11, 11, 7, 8, 6, 8, 8, 10, 6, 8, 6, 6, 7, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 16, 6, 15, 6, 7, 11, 11, 7, 9, 10, 11, 13, 10, 6, 16, 8, 10, 12, 11, 6, 6, 6, 6, 6, 6, 6, 10, 6, 10, 7, 7, 7, 11, 7, 11, 6, 6, 6, 6, 6, 6, 17, 7, 7, 6, 6, 12, 22, 6, 6, 6, 6, 6, 8, 6, 6, 6, 6, 7, 6, 6, 5, 6, 6, 8, 11, 6, 9, 14, 11, 9, 11, 7, 7, 8, 6, 6, 6, 8, 10, 9, 6, 6, 6, 6, 9, 7, 6, 6, 6, 6, 6, 15, 6, 4, 4, 4, 6, 4, 17, 8, 11, 6, 6, 9, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 7, 6, 6, 6, 6, 10, 6, 10, 6, 6, 6, 6, 12, 8, 6, 6, 6, 6, 6, 6, 6, 6, 6, 9, 6, 6, 6, 6, 18, 6, 6, 6, 8, 9, 10, 7, 8, 9, 10, 11, 7, 13, 6, 8, 8, 6, 6, 14, 7, 7, 7, 7, 10, 7, 14, 9, 6, 6, 9, 15, 9, 7, 14, 6, 11, 14, 13, 7, 12, 8, 7, 7, 7, 7, 7, 12, 7, 10, 9, 16, 6, 8, 6, 5, 17, 6, 8, 10, 4, 6, 4, 10, 15, 17, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 4, 4, 11, 7, 4, 4, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 19, 17, 6, 10, 11, 6, 6, 6, 6, 18, 6, 6, 11, 4, 4, 4, 5, 6, 6, 6, 9, 5, 6, 4, 6, 6, 4, 6, 6, 6, 6, 10, 6, 6, 4, 6, 6, 10, 6, 10, 6, 6, 6, 6, 11, 6, 6, 10, 6, 6, 8, 6, 6, 6, 8, 6, 11, 4, 11, 9, 10, 9, 11, 4, 8, 4, 11, 12, 7, 9, 8, 6, 7, 7, 8, 12, 12, 11, 13, 10, 11, 7, 7, 7, 9, 7, 11, 10, 7, 7, 7, 16, 11, 10, 11, 17, 9, 9, 8, 8, 7, 7, 7, 9, 7, 7, 7, 14, 7, 13, 9, 11, 10, 14, 10, 10, 12, 11, 10, 7, 10, 5, 14, 8, 8, 8, 9, 7, 8, 7, 7, 9, 8, 7, 8, 7, 7, 7, 7, 7, 7, 7, 11, 8, 10, 8, 7, 8, 14, 11, 8, 9, 9, 9, 8, 24, 10, 10, 12, 7, 7, 15, 11, 8, 8, 12, 11, 8, 9, 9, 7, 8, 9, 10, 11, 10, 11, 7, 12, 7, 7, 11, 9, 8, 14, 13, 12, 8, 11, 10, 8, 8, 7, 7, 14, 9, 10, 8, 9, 11, 7, 14, 8, 8, 13, 8, 8, 12, 7, 10, 14, 14, 11, 9, 10, 9, 9, 7, 7, 11, 11, 13, 9, 13, 5, 5, 5, 7, 9, 5, 11, 12, 14, 8, 7, 7, 11, 10, 9, 7, 8, 8, 7, 10, 11, 11, 5, 5, 7, 5, 5, 5, 7, 7, 15, 7, 7, 8, 7, 15, 12, 12, 10, 7, 8, 7, 11, 7, 7, 7, 23, 11, 8, 8, 11, 10, 7, 8, 11, 7, 19, 7, 7, 6, 9, 9, 9, 11, 3, 4, 7, 8, 6, 6, 4, 10, 8, 2, 2]);
  var edgeChild = /* @__PURE__ */ new Uint16Array([0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 12, 1, 1, 1, 1, 1, 17, 1, 1, 1, 1, 1, 1, 12, 1, 12, 1, 12, 13, 1, 1, 1, 1, 12, 1, 12, 1, 1, 1, 1, 1, 14, 23, 1, 1, 1, 1, 1, 20, 1, 1, 1, 1, 21, 12, 1, 1, 1, 1, 1, 1, 1, 1, 22, 1, 1, 1, 16, 18, 1, 1, 15, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 24, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 19, 1, 1, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 1, 26, 27, 28, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 12, 12, 12, 12, 1, 34, 0, 0, 0, 1, 1, 1, 1, 37, 36, 1, 1, 1, 1, 1, 35, 1, 1, 1, 1, 39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 41, 42, 0, 0, 0, 0, 12, 1, 1, 1, 12, 1, 1, 1, 45, 47, 47, 47, 45, 47, 45, 45, 46, 47, 45, 47, 45, 45, 45, 45, 45, 45, 47, 45, 45, 46, 45, 45, 45, 45, 47, 48, 48, 46, 47, 45, 45, 45, 45, 45, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 51, 53, 51, 51, 51, 53, 51, 52, 51, 54, 51, 52, 52, 51, 51, 51, 52, 54, 52, 54, 51, 52, 52, 12, 56, 56, 55, 57, 52, 54, 51, 51, 49, 50, 58, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 61, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 68, 69, 12, 1, 1, 67, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 12, 78, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 82, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80, 83, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 12, 1, 1, 1, 1, 93, 1, 95, 1, 1, 1, 1, 1, 1, 1, 1, 98, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 101, 101, 1, 1, 12, 1, 104, 1, 1, 1, 1, 1, 1, 1, 102, 1, 103, 1, 105, 1, 1, 1, 1, 1, 106, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 114, 115, 1, 1, 1, 1, 1, 1, 117, 117, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 125, 126, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 126, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 126, 1, 1, 1, 1, 1, 1, 1, 1, 1, 130, 127, 129, 124, 1, 128, 1, 1, 118, 1, 1, 1, 1, 121, 1, 131, 1, 1, 1, 1, 1, 1, 123, 1, 112, 1, 113, 1, 12, 132, 110, 116, 1, 1, 1, 1, 1, 111, 119, 1, 12, 12, 12, 122, 120, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 12, 12, 1, 1, 1, 1, 1, 12, 138, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 140, 1, 1, 1, 1, 1, 1, 1, 1, 141, 142, 12, 12, 139, 137, 47, 47, 144, 51, 51, 143, 146, 145, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 149, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 147, 0, 0, 0, 0, 1, 0, 148, 136, 1, 0, 1, 1, 12, 12, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 152, 151, 22, 1, 1, 12, 12, 1, 22, 12, 12, 1, 1, 1, 1, 1, 138, 1, 1, 156, 1, 1, 1, 1, 157, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 1, 1, 140, 1, 1, 156, 1, 1, 1, 1, 157, 1, 1, 1, 138, 1, 1, 1, 156, 1, 161, 1, 1, 1, 157, 1, 1, 138, 1, 1, 1, 161, 1, 1, 1, 1, 1, 138, 1, 1, 1, 1, 1, 1, 1, 1, 138, 1, 1, 161, 1, 1, 161, 1, 1, 1, 1, 1, 1, 1, 167, 1, 1, 1, 156, 1, 1, 161, 1, 1, 1, 157, 1, 1, 167, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 140, 1, 1, 156, 1, 161, 1, 1, 1, 157, 1, 1, 138, 1, 1, 156, 1, 161, 1, 1, 1, 157, 1, 1, 138, 1, 1, 1, 1, 156, 1, 161, 1, 1, 1, 157, 1, 1, 1, 138, 1, 1, 156, 1, 1, 1, 1, 173, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 1, 176, 1, 1, 167, 1, 1, 1, 1, 1, 156, 1, 1, 161, 1, 1, 1, 157, 1, 1, 167, 1, 1, 1, 1, 1, 156, 1, 1, 161, 1, 1, 1, 157, 1, 1, 167, 1, 1, 1, 1, 1, 161, 1, 1, 1, 1, 171, 163, 163, 12, 1, 12, 175, 1, 1, 1, 1, 1, 164, 164, 164, 158, 1, 1, 1, 162, 164, 168, 174, 1, 1, 1, 1, 162, 162, 1, 1, 160, 158, 171, 162, 166, 179, 170, 179, 1, 1, 177, 1, 170, 159, 162, 1, 1, 1, 1, 162, 1, 165, 1, 1, 1, 12, 1, 180, 1, 169, 1, 1, 1, 169, 168, 172, 178, 160, 171, 1, 1, 1, 1, 1, 1, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 182, 183, 182, 182, 183, 182, 182, 182, 182, 184, 184, 182, 182, 183, 182, 183, 182, 182, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 186, 12, 1, 12, 12, 12, 12, 1, 12, 12, 12, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 199, 1, 201, 202, 200, 199, 199, 1, 1, 205, 1, 206, 204, 1, 12, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 217, 199, 199, 199, 199, 217, 1, 1, 1, 1, 220, 221, 219, 1, 1, 1, 1, 1, 1, 223, 223, 1, 1, 1, 223, 223, 225, 226, 224, 1, 228, 1, 1, 1, 1, 12, 234, 235, 236, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 203, 207, 1, 1, 1, 1, 155, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 231, 1, 1, 1, 198, 1, 1, 1, 1, 242, 1, 1, 239, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 189, 214, 1, 1, 1, 210, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 196, 1, 1, 1, 1, 1, 1, 1, 215, 1, 1, 1, 1, 230, 1, 1, 1, 1, 181, 1, 218, 1, 213, 1, 1, 1, 216, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 194, 1, 12, 1, 1, 12, 1, 1, 1, 1, 197, 1, 1, 1, 212, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 243, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 229, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 188, 12, 1, 1, 1, 191, 12, 1, 1, 1, 1, 1, 1, 1, 233, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 190, 1, 1, 1, 1, 1, 1, 1, 238, 1, 1, 1, 195, 1, 1, 1, 211, 1, 12, 1, 227, 208, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 215, 1, 1, 1, 1, 193, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 185, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 209, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 240, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 241, 1, 1, 12, 1, 1, 1, 1, 192, 1, 1, 1, 209, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 232, 1, 1, 1, 187, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 222, 1, 1, 1, 12, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 237, 1, 1, 12, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 253, 0, 0, 0, 0, 0, 254, 0, 0, 0, 0, 0, 0, 1, 12, 1, 1, 1, 258, 1, 1, 1, 0, 259, 256, 257, 1, 1, 1, 1, 1, 1, 264, 1, 266, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 262, 1, 1, 1, 1, 1, 268, 1, 1, 12, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 267, 1, 1, 1, 12, 1, 1, 1, 1, 263, 1, 1, 1, 261, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 265, 1, 1, 1, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 1, 12, 1, 1, 1, 12, 1, 1, 274, 1, 13, 1, 1, 1, 12, 12, 271, 272, 1, 1, 1, 1, 273, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 275, 1, 1, 12, 16, 1, 1, 1, 1, 1, 1, 276, 1, 1, 1, 12, 12, 1, 1, 1, 1, 1, 1, 1, 276, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 285, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 289, 289, 1, 0, 0, 0, 0, 0, 1, 12, 0, 0, 0, 0, 0, 0, 0, 0, 182, 1, 294, 295, 1, 12, 1, 1, 1, 1, 12, 297, 1, 1, 296, 1, 1, 299, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 303, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 12, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 12, 0, 314, 0, 0, 315, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 61, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 339, 0, 0, 0, 0, 0, 0, 0, 0, 0, 341, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 357, 357, 358, 357, 0, 209, 1, 1, 13, 353, 1, 351, 0, 0, 0, 0, 0, 0, 0, 354, 1, 1, 359, 1, 239, 1, 1, 1, 1, 352, 1, 349, 1, 355, 1, 347, 1, 356, 1, 348, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 12, 350, 350, 1, 1, 1, 198, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 12, 1, 1, 1, 1, 346, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 362, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 299, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 402, 402, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 394, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 370, 381, 1, 1, 369, 404, 1, 375, 1, 1, 367, 399, 1, 1, 385, 366, 371, 1, 1, 1, 378, 409, 387, 1, 1, 1, 1, 1, 1, 388, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 397, 401, 0, 0, 83, 1, 1, 0, 395, 372, 408, 373, 376, 383, 1, 398, 0, 1, 0, 83, 392, 390, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 411, 1, 1, 382, 1, 83, 1, 0, 1, 1, 1, 414, 1, 0, 0, 83, 389, 0, 1, 368, 1, 1, 1, 0, 1, 1, 391, 1, 0, 1, 1, 1, 0, 1, 416, 379, 1, 1, 0, 1, 0, 0, 407, 0, 1, 1, 1, 83, 400, 1, 1, 396, 393, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 374, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 406, 0, 83, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 410, 1, 1, 1, 0, 0, 413, 0, 0, 0, 1, 386, 1, 0, 83, 412, 1, 0, 0, 0, 0, 415, 1, 1, 0, 0, 1, 0, 1, 0, 384, 0, 380, 0, 1, 1, 1, 0, 1, 1, 0, 403, 377, 405, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 12, 1, 1, 1, 12, 431, 431, 1, 1, 12, 12, 1, 431, 1, 1, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 443, 1, 1, 0, 1, 1, 1, 1, 239, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 461, 461, 1, 1, 0, 0, 347, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 474, 1, 473, 1, 1, 1, 1, 1, 1, 1, 1, 1, 478, 1, 12, 12, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 486, 1, 1, 1, 488, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 485, 1, 480, 1, 1, 1, 1, 467, 1, 1, 1, 1, 1, 1, 1, 1, 481, 12, 1, 1, 1, 1, 487, 1, 1, 1, 482, 476, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 347, 1, 464, 1, 1, 12, 484, 1, 1, 347, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 469, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 487, 1, 1, 1, 1, 347, 1, 483, 1, 1, 1, 477, 471, 1, 1, 1, 1, 1, 472, 1, 489, 475, 1, 1, 1, 1, 1, 470, 1, 1, 1, 1, 1, 1, 1, 1, 1, 465, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 479, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 468, 1, 1, 1, 1, 1, 466, 1, 253, 490, 1, 1, 1, 1, 1, 12, 1, 1, 1, 1, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 0, 496, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 12, 1, 69, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500, 0, 500, 500, 500, 500, 500, 500, 500, 0, 500, 500, 500, 500, 500, 1, 500, 500, 500, 0, 500, 500, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 505, 504, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 509, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 502, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 503, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 511, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 508, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 501, 0, 0, 512, 507, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 506, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 501, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 510, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 522, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 233, 233, 1, 526, 1, 1, 1, 525, 1, 1, 1, 1, 521, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 523, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 527, 1, 1, 524, 1, 1, 1, 1, 1, 1, 1, 1, 402, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 528, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 539, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 12, 1, 542, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 12, 12, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 61, 1, 1, 12, 12, 12, 12, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 561, 1, 1, 1, 1, 1, 1, 1, 562, 1, 1, 1, 1, 1, 1, 1, 560, 1, 1, 12, 1, 1, 564, 272, 1, 1, 1, 12, 12, 1, 1, 12, 1, 12, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 568, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 574, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 136, 1, 12, 579, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 111, 1, 1, 12, 1, 1, 1, 1, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 584, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 148, 1, 1, 1, 261, 1, 1, 12, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 609, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 253, 1, 358, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 614, 1, 1, 1, 1, 0, 616, 0, 83, 0, 615, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 12, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 623, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 618, 618, 0, 622, 620, 618, 618, 618, 618, 618, 624, 618, 618, 628, 618, 618, 618, 618, 618, 618, 618, 618, 618, 618, 625, 622, 618, 618, 622, 618, 618, 618, 618, 618, 618, 618, 618, 618, 618, 618, 618, 618, 620, 618, 618, 618, 618, 618, 626, 618, 618, 618, 618, 618, 618, 0, 0, 0, 1, 627, 1, 1, 1, 1, 621, 1, 1, 1, 1, 1, 619, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 12, 632, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 12, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 12, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 12, 1, 1, 12, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 66, 311, 337, 442, 570, 0, 4, 70, 269, 287, 313, 338, 364, 418, 444, 0, 533, 554, 571, 634, 9, 0, 62, 92, 428, 440, 460, 612, 0, 531, 553, 567, 649, 0, 32, 6, 0, 495, 534, 639, 597, 72, 0, 7, 316, 288, 419, 497, 447, 573, 83, 635, 0, 613, 340, 449, 499, 9, 109, 319, 540, 6, 32, 0, 342, 83, 421, 83, 517, 10, 6, 135, 281, 306, 0, 650, 544, 0, 600, 0, 65, 6, 6, 284, 99, 2, 463, 429, 441, 633, 0, 6, 0, 6, 317, 107, 6, 598, 535, 575, 0, 498, 420, 304, 318, 8, 73, 108, 636, 578, 422, 343, 331, 450, 150, 76, 321, 582, 545, 638, 601, 365, 360, 513, 6, 77, 153, 11, 0, 282, 557, 583, 602, 549, 587, 607, 648, 38, 6, 293, 326, 363, 335, 251, 32, 563, 590, 251, 43, 249, 298, 327, 336, 437, 454, 515, 305, 0, 75, 599, 0, 434, 448, 330, 83, 280, 83, 0, 617, 581, 538, 323, 452, 83, 423, 417, 0, 0, 0, 9, 592, 608, 250, 0, 455, 438, 566, 551, 610, 652, 89, 251, 44, 328, 426, 456, 606, 0, 546, 324, 307, 83, 248, 84, 30, 420, 32, 6, 424, 361, 334, 641, 629, 559, 586, 548, 0, 291, 85, 32, 436, 453, 0, 32, 457, 0, 252, 630, 552, 9, 439, 458, 251, 281, 90, 255, 631, 611, 594, 516, 459, 427, 283, 260, 91, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 657, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 445, 0, 0, 0, 0, 0, 0, 0, 0, 86, 0, 133, 0, 0, 541, 585, 0, 0, 0, 0, 0, 0, 0, 29, 0, 588, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 445, 0, 0, 0, 0, 537, 0, 290, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 325, 0, 0, 0, 0, 0, 0, 0, 654, 0, 0, 0, 0, 0, 653, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 425, 0, 0, 0, 518, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 71, 0, 0, 0, 0, 0, 0, 529, 0, 0, 0, 0, 0, 0, 435, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 244, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 550, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 530, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 302, 312, 0, 0, 0, 0, 0, 565, 308, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 547, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 491, 0, 0, 0, 345, 0, 0, 0, 0, 79, 0, 286, 0, 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 605, 0, 0, 0, 0, 637, 556, 0, 0, 0, 0, 277, 0, 0, 0, 0, 0, 0, 493, 0, 0, 514, 0, 0, 0, 0, 0, 63, 0, 0, 0, 300, 59, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 279, 0, 0, 0, 0, 0, 310, 647, 0, 74, 0, 0, 0, 0, 0, 0, 0, 0, 0, 656, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 154, 0, 309, 0, 0, 0, 0, 0, 0, 604, 0, 0, 0, 0, 0, 0, 558, 0, 0, 0, 0, 0, 0, 0, 0, 0, 603, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 246, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 88, 0, 536, 0, 0, 0, 0, 0, 591, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 88, 87, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 520, 0, 519, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 292, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 492, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 320, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 572, 0, 0, 0, 0, 0, 0, 0, 0, 329, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 71, 270, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 88, 0, 643, 0, 0, 589, 0, 0, 0, 0, 0, 0, 0, 0, 0, 278, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 646, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 555, 0, 0, 0, 88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 532, 0, 651, 0, 0, 462, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 433, 0, 0, 0, 580, 0, 97, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 0, 0, 0, 0, 0, 0, 31, 96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 322, 0, 0, 0, 247, 0, 0, 0, 0, 0, 0, 595, 0, 0, 0, 0, 134, 0, 0, 0, 0, 0, 596, 0, 0, 0, 0, 0, 0, 0, 445, 451, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 430, 0, 344, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 332, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 569, 0, 0, 0, 446, 0, 0, 432, 0, 0, 0, 0, 0, 0, 640, 0, 0, 0, 576, 0, 0, 94, 0, 577, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 543, 494, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 301, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 445, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 645, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 644, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 655, 0, 0, 0, 0, 0, 593, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 333, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 642, 0, 0, 245, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 660, 660, 660, 660, 660, 660, 660, 659, 661]);
  var labelText = "orgmilcomschnetedugovdrrformsfeedbackofficialaccoorgmilschnetgovmagazinemediaunioncargopilotgroupcaarespressworksaerodromeworkinggroupair-traffic-controlaircraftaccident-preventioneducatormarketplaceambulanceinsurancecateringairportrepbodyenginesoftwaremodellingair-surveillanceconsultingchartertrainermaintenanceservicesdesignflightskydivingfreightassociationstudentgroundhandlingdgcafuelclubtaxicrewshowballooningexpresstraderbrokerauthoragentsairtrafficjournalistsafetyconsultantmicrolightaccident-investigationparachutingequipmentproductionfederationrecreationscientistnavigationengineertradingglidingleasingresearchpassenger-associationentertainmentparaglidinghangglidingaerobaticrotorcraftemergencycertificationgovernmentaeroclubexchangelogisticschampionshiphomebuiltcouncilconferencecontrolairlinecivilaviationjournalorgcomnetedugovcoorgcomnomnetobjofforgcomnetuwukiloappsframerorgmilcomnetedugovcoradioorgcomnetcommuneedogpbcoitgvorgedugov*spreviewfrontendrelayononstagingauthcloudsandboxupid*mtls*privatelinktypedreamdeveloperbravemochawindsurfaivenmirenupsunwnextbegetngrokclerkwale2bwebcsbrunputerflutterflowcloudzyrospawnbasesliplanemodelenceshiptodaymagicpatternsnetlifyondigitaloceanrailwayhostedclaudehasurabotdashretoolvercelgithubluyanigadgetreplitcloudflaretelebitedgecomputeevervaultexponyatnoopencrpplxzeaburwasmerframerzeropsrocketpreviewconvexmedusajsspritesonherculeseasypanelstreamlitglideossnowflakemesserliloginlinehackclubcodepennorthflankbase44corespeedleapcellngrok-freeclerkstagelovableon-fleek*us-west-3ap-south-2us-central-2us-central-1eu-central-1ap-south-1us-west-2us-east-2eu-north-1ap-north-1us-west-1us-east-1*rcloudintsegorgmilcomgobbetnetintedugovturmusicasenasamutualcoopip6uriurnin-addre164homeirisgovdixdaemoncloudnssthwien*inexexkunden4accogvormymyspreadshop4lima2ixortsinfofuturecmsfuturehosting12hpprivfuturemailinglima-cityfunkfeuer123webseitednshomemelmyspreadshopcloudletswasantqldvicactnswtascatholicwasaqldvictasidwasantozqldorgcomvicasnactnetedugovnswtasconfcomairflowlambda-urltransfer-webapptransfer-webappairflowtransfer-webapptransfer-webapp-fipstransfer-webappeu-west-3ap-south-2eu-south-2eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3eu-central-1mx-central-1me-central-1ca-central-1il-central-1ap-northeast-1ap-southeast-1me-south-1af-south-1eu-south-1ap-south-1ap-southeast-7us-west-2eu-west-2ap-east-2us-east-2eu-north-1ap-southeast-2ap-northeast-2ap-southeast-5us-gov-west-1us-gov-east-1ap-southeast-6ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1privatenotebookstudiolabelingnotebookstudionotebooknotebook-fipslabelingnotebookstudionotebook-fipsnotebookstudio-fipsnotebook-fipsnotebookstudionotebook-fipsnotebookstudioeu-west-3ap-south-2eu-south-2eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3eu-central-1me-central-1ca-central-1il-central-1ap-northeast-1ap-southeast-1me-south-1af-south-1eu-south-1ap-south-1us-west-2eu-west-2us-east-2eu-north-1ap-southeast-2ap-northeast-2experimentsus-gov-west-1us-gov-east-1ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1onrepostsagemakercopporgmilcompronetintedugovbiznameinfoshoprsorgmilcomnetedugovbrendlyresolvenzauscotvstoreorgcomnetedugovbizinfoidacaicoittvorgmilcomschnetedugovinfocloudezproxysiteacmymyspreadshopkuleuvenwebhostingtransurl123websitecloudnsinterhostsolutionsddns5476103298edgfacbmlonihkjutwvqpsryxzbarsycoororgcomedumyftpno-iporxcloud-ipfor-somemmafanfor-morewebhopselfipjozidyndnscloudnsdscloudfor-thefor-betteractivetrailcoeconorestooteorgcomeconeteduassurmoneyafricaarchitectesrestaurantloisirstourismavocatsinfoagrounivcoorgcomnetedugoviatvdeportesaludtksatorgmilcomwebgobnetinteducienciaboliviarevistacooperativaempresanombreindustriamusicapatriamedicinademocraciapoliticapuebloindigenaplurinacionalarteblogwikiinfoagrotransportenoticiasprofesionalacademiaeconomiaecologiamovimientotecnologianaturalpagesappsgroksimplesitecepesebamapadfmgalampbacscpirngorotomtrjspaprrprrsesmscepesebamapadfmgalampbacscpirngorotomtrjspaprrprrsesms*biaamfmtcmptvfeirasampajampanatalbelemananiradiog12medindfndbmdtrdthepoaggfjdfdefinfenflegsegongengcngorgzlgslglogppgmillelqslcimcomnomadmjabimbbibbsbabcrectecsjcetcpscpvhudieticriapipsiecnbiorioecogeoteoodoproatoartfstmatvetdetbetnetcntnotfotgrueduajuespappreptmpemparqsrvadvdevgovntrturagrjorfarjusmusdesvixxyzcozfozslzbhzmaringasantamariacampinagrandegoianiasorocabafloripasaobernardocuritibaboavistarecifeaparecidasaogoncasalvadorcuiabamorenamacapalondrinacontagemsocialfortalmaceioleilaoosascoriobranconiteroi9guacutcheblogflogvlogwikitaxicoopmanauspalmascaxiasjoinvillebaruericampinassantoandreribeiraoriopretoweorgcomnetedugovv0windsurfshiptodaycloudsitecoaccoorgnetgovofmilcomgovmediatechzacoorgcomnetedugsjgovmydnspenfnlabnbmbgcbcqconcontnuyksknsmyspreadshopno-ipawdevboxbarsyonidatemfuinabusavinstanceseceuguukussryzespawncsxcloud-ipmyphotosfantasyleaguetwmailcleverappsscrappingccwucloudnsftpaccessgame-serverccgovobjectsrmalpgcust*svcalp1aeappenginermalpgmyspreadshop4lima2ixsquare7cloudscale123websitefirenet12hpflowgotdnslinkyard-cloudcloudnslima-citydnskingobjectstorageedaccogoorusorgcomnetinteduaéroportxn--aroport-byaassogouvcomilgobgovcloudnses-1eu-west-1us-east-1euvipit1eurarubait1s3lbwebsites3websiteru-spbru-mskelasticcsrunstnukukcaukusnl-ams-1fr-par-1fr-par-2functionsnodess3ddlwhmrdbfnck8sifrs3-websitecockpitscblmgdbdtwhkafkpubprivs3ddlwhmrdbk8sifrs3-websitecockpitscblmgdbdtwhkafks3ddlrdbk8sifrs3-websitecockpitscblmgdbdtwhkafkk8sscalebookpl-wawfr-parnl-amsbaremetalsmartlabelinginstancesdechk2kuleuvenlaravelvoorloperurownoxazapscwhstgrvaporonline-serverobservablehqelementorantagonistreclaimjoteluluencowaydiademjelasticmatlabmagentositetrendhostingaxarnetjenv-arubajelejoteravendbemergenttrafficplexconvexkeliwebserveboltbegetcdnstaticson-rancherprimetelonstackitunison-servicesdnshomelinkyardbarsyjelecloudnscocomnetgovmycn-northwest-1cn-north-1s3s3-accesspoints3-websites3s3-accesspointrdsdualstacks3-deprecatedemrappui-prods3-websiteemrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apis3s3-accesspoints3s3-accesspointrdsdualstackemrappui-prods3-websiteemrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apicn-northwest-1cn-north-1cn-northwest-1ebcomputeelbcn-north-1airflowcn-northwest-1cn-north-1oncn-northwest-1cn-north-1amazonawssagemakeramazonwebservicesdirectasgdsdhehahljlnmhbacscahqhshhihnlnynsnmofjbjzjxjtjhkcqtwgsjssxnxjxgxxzgz網絡网络公司orgmilcomnetedugovxn--55qx5dcanva-appsxn--io0a7iquickconnectcanvasitekhsjxn--od0algcanva-codemyqnapcloudsrvrlessclustersrealtimestorageleadpagescarrdcrdorgmilcomnomnetedugovhidnssupabaserdpareplmypiumsoxmitotaplpagesfirewalledreplitowodevwebview-assetsvfswebview-assetss3s3-accesspointdualstackemrappui-prods3-websiteaws-cloud9emrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apicloud9eu-west-3ap-south-2eu-south-2eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3eu-central-1me-central-1ca-central-1il-central-1ap-northeast-1ap-southeast-1me-south-1af-south-1eu-south-1ap-south-1ap-southeast-7us-west-2eu-west-2us-east-2eu-north-1ap-southeast-2ap-northeast-2ap-southeast-5ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1s3s3-accesspointdualstackemrappui-prods3-websiteaws-cloud9emrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apicloud9consent-portals3s3-accesspointdualstackanalytics-gatewayemrappui-prods3-websiteaws-cloud9emrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9s3s3-accesspointdualstackemrappui-prods3-websiteemrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apis3s3-accesspointdualstackemrappui-prods3-websiteemrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apis3s3-accesspointdualstacks3-deprecateds3-websitebedrock-agentcores3-object-lambdaexecute-apibedrock-agentcores3s3-accesspoints3-websites3-accesspoint-fipss3-fipss3s3-accesspointdualstackemrappui-prods3-websites3-accesspoint-fipsaws-cloud9s3-fipsemrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9s3s3-accesspointdualstackemrappui-prods3-websites3-accesspoint-fipss3-fipsemrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apis3s3-accesspointdualstackemrappui-prods3-websiteaws-cloud9emrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9s3s3-accesspointdualstackemrappui-prods3-websiteaws-cloud9emrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9s3s3-accesspointdualstacks3-deprecatedanalytics-gatewayemrappui-prods3-websiteaws-cloud9emrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9vfss3s3-accesspointdualstackemrappui-prods3-websiteaws-cloud9emrstudio-prods3-object-lambdaemrnotebooks-prodexecute-apicloud9eu-west-3ap-south-2eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3eu-central-1mx-central-1me-central-1ca-central-1il-central-1ap-northeast-1us-northeast-1ap-southeast-1me-south-1af-south-1ap-south-1ap-southeast-7us-west-2eu-west-2ap-east-2us-east-2ap-southeast-2ap-northeast-2ap-southeast-5us-gov-west-1us-gov-east-1ap-southeast-6ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1mrapaccesspoints3s3-accesspointdualstacks3-deprecatedanalytics-gatewayemrappui-prods3-websites3-accesspoint-fipsaws-cloud9s3-fipsemrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9s3s3-accesspointdualstacks3-deprecatedanalytics-gatewayemrappui-prods3-websites3-accesspoint-fipsaws-cloud9s3-fipsemrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apicloud9s3s3-accesspointdualstackemrappui-prods3-websites3-accesspoint-fipss3-fipsemrstudio-prodbedrock-agentcores3-object-lambdaemrnotebooks-prodexecute-apis3eu-west-3ap-south-2eu-south-2computes3-ap-northeast-2elbrdss3-ap-east-1s3-sa-east-1s3-us-gov-west-1s3-eu-central-1s3-ca-central-1eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3s3-website-us-west-2s3-website-eu-west-1s3-external-1eu-central-1me-central-1ca-central-1il-central-1s3-us-west-1s3-eu-west-1s3-website-sa-east-1s3-website-ap-southeast-2ap-northeast-1ap-southeast-1s3-us-west-2s3-eu-west-2me-south-1af-south-1eu-south-1ap-south-1ap-southeast-7us-west-2eu-west-2us-east-2s3-website-ap-southeast-1s3-1s3-globals3-ap-northeast-3eu-north-1airflowap-southeast-2s3-us-gov-east-1s3-fips-us-gov-east-1s3-me-south-1s3-ap-south-1ap-northeast-2s3-website-us-west-1ap-southeast-5s3-eu-north-1s3-ap-southeast-1s3-website-us-gov-west-1compute-1s3-eu-west-3us-gov-west-1s3-website-ap-northeast-1us-gov-east-1s3-fips-us-gov-west-1s3-website-us-east-1s3-ap-southeast-2ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1s3-us-east-2s3-ap-northeast-1authauthauth-fipsauth-fipseu-west-3ap-south-2eu-south-2eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3eu-central-1mx-central-1me-central-1ca-central-1il-central-1ap-northeast-1ap-southeast-1me-south-1af-south-1eu-south-1ap-south-1ap-southeast-7us-west-2eu-west-2ap-east-2us-east-2eu-north-1ap-southeast-2ap-northeast-2ap-southeast-5us-gov-west-1us-gov-east-1ap-southeast-6ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1eu-west-3eu-south-2ap-southeast-3eu-central-1ca-central-1ap-northeast-1ap-southeast-1ap-south-1us-west-2eu-west-2us-east-2eu-north-1ap-southeast-2ap-northeast-2ap-southeast-5eu-west-1us-east-1ap-east-1sa-east-1csrframeservicesbuilderstg-builderdev-builder*ociocpocsazuregcpawsdemoinstanceeu-west-3ap-south-2eu-south-2eu-central-2ap-southeast-3ap-southeast-4ap-northeast-3eu-central-1me-central-1ca-central-1il-central-1ap-northeast-1ap-southeast-1me-south-1af-south-1eu-south-1ap-south-1ap-southeast-7us-west-2eu-west-2us-east-2eu-north-1ap-southeast-2ap-northeast-2ap-southeast-5us-gov-west-1us-gov-east-1ap-southeast-6ca-west-1us-west-1eu-west-1us-east-1ap-east-1sa-east-1previeweu-4us-4us-1eu-1us-2eu-2us-3eu-3appss3-websitekrkrobjectprivateobjectkrkrskrkrsobjectkrprivateobjectkr-privatecomputepaasrag-cloudrag-cloud-chjcloudjcloud-ver-jpcdemonodebalancermembersipeuxvsoncillaocelotonzayalilynxsphinxfentigercustomercaracalsgkrobjectstoragedesgkrusobjectkrkr-naverkr-naver-devkrprivatewebsiteobjectkr-naverkr-privatekr-naver-devjpjpkrjp4jp5s3-website-jpjpkrjp4jp5objectprivateobjecto365cloudstaticxendevapp001testcode-builder-stgplatformmediasiteprojedrydpagesjsx0desazacncoitrueu4uhkukgrbrushatenadiarymyspreadshopfrom-flfrom-wvwebspace-hosttheworkpchatenablogcursorusercontentservesarcasmapplinzisakuratanwixsitefin-ncloudstoragegov-ncloudstorageappchizigiizeis-into-carsdnsiskinkyadobeaemcloudis-a-therapistpgfogmyvncdojinis-an-actress1kappfldrvkozowqa2jpnmexprgmrfirewall-gatewaydynnscafjsfbsbxooguyfrom-gawoltlab-demois-a-anarchistwiardwebteaches-yogadattowebtb-hostinglive-websiteservegamegotpantheonfrom-nhsubsc-payfrom-ohvipsinaappfrom-cadyndns-officeztna-dingtalkhomelinuxfrom-mahercules-appservebbsstreakusercontentfrom-okfrom-wyfastly-terrariumis-a-llamaqualyhqportalserveexchangeon-vaporvivenushopciscofreakgrayjayleaguesmetaaiusercontentfrom-iais-a-libertariansaves-the-whalestaveusercontentyolasiteoperaunitepoint2thisis-a-catererclaudeusercontentlinodeusercontentfrom-vagithubusercontentsells-for-lesshosteurcanva-appsplaystation-cloudddnsfreefrom-pafrom-prfrom-waddnskingoutsystemscloudhotelwithflightmydattois-a-nascarfanmydbserverminiserverdamnserverservehumouris-a-playerfrom-nvfrom-nmemergentagentgentappsamplifyappfrom-kyis-an-accountantnfshostserveircfrom-akpythonanywherestackhero-networkpostman-echolikescandydyndns-mailobservableusercontentserveftpfreeboxosfrom-utcdn77-storageamazonawsneat-urlnclouddyndns-serverlinodeis-a-teacherfrom-vtgleezemythic-beastsus1-pleniteu1-plenitla1-plenitpaywhirlservecounterstrikejdevcloudhealth-carereformis-into-animegoogleapisis-a-painterafricaisa-hockeynutatmetais-an-actora2hostedis-a-democratdatadetectest-le-patrondigitaloceanspacesis-a-designeris-a-hunterlinodeobjectstemp-dnsissmarterthanyoufrom-arsimplesiteevennodetownnews-stagingis-a-liberalgooglecodejelasticservemp3qualyhqpartnerdyndns-free1cooldnsest-a-la-masiondrayddnsdynuddnsfrom-orfrom-miis-a-bloggerfrom-himydobisscanvacodeis-an-engineerest-a-la-maisonupsunappdevinappswafflecellmyasustorwpenginepoweredfrom-ctservep2psame-appmyshopblocksthingdustdatalikes-piediscordsezis-with-thebandlpusercontentis-leetshopitsite3utilitiesis-a-personaltrainersinaappladeskis-a-cheflogoipselfipbase44-sandboxnospamproxyalibabacloudcsmesswithdnsauthgearappsiamallamawithgooglelutrausercontentmochausercontentframercanvasmytabitdyndns-homew-credentialless-staticblitzcpserverdiscordsaysis-a-nurseappspotatlassian-isolated-3premotewdfrom-mtwixstudiocode0emm180rmyactivedirectoryawsappsmytuleapdnsabrpolyspaceqbuserrenderbuiltwithdarkboutirgotdnsabrdnsdopaascanva-hosted-embedawsglobalacceleratorhomesecuritypcmyiphostditchyouripclever-clouddyndns-ipon-aptibleis-a-musicianhosted-by-filessecuritytacticsappspaceusercontenthomeunixstrapiappsame-previewcf-ipfsmycloudnaselasticbeanstalkis-certifieddontexistkasserverik-serverdrive-platformatlassian-3pfirebaseappncpstorageherokuappawsapprunnerbarsycenteris-a-cubicle-slaveservehttpmyshopifyis-a-guruquicksytessiiitesorsitesmagicpatternsappis-a-cpameteorappfrom-wiis-a-rockstarbumbleshrimpdattolocaldatabricksappsreadthedocs-hostedfrom-rifamilydsdyndns-picsplesknsbplaceddnsaliasdynaliasdyndns-remotedoomdnsip-ddnsblogdnsis-a-doctorroutingthecloudamazoncognitobarsyonlinedsmynasddnsgurucloudflare-ipfsdeus-canvasfrom-idsmushcdnpagespeedmobilizerdyndns-at-homeunusualpersonhosted-by-previderis-a-republicandyn-o-saurstreamlitappworkisboringonthewificprapidqualifioappis-uberleetis-slickgetmyipwpdevcloudtypeformdyndns-at-workgentlentapismynascloudw-corp-staticblitzfrom-ingeekgalaxyservebeerfrom-mdonrenderspace-to-rentaivencloudappspacehostedwafaicloudcodespotblogspotatlassian-3p-us-gov-modfrom-ndfrom-msis-a-techieis-a-studentcustomer-ociis-a-photographerdurumisfrom-ksmassivegriddyndns-wikiis-an-entertaineris-a-hard-workermysecuritycamerafrom-mnrackmazedyndns-blogis-a-bulls-fanwritesthisblogfreemyipsimple-urlfrom-sdreservdauthgear-stagingest-mon-blogueuris-into-gamesrice-labsxtooldevicesakurawebis-an-anarchistoraclecloudappsdyndns-worksells-for-urhcloudfrom-dcfastvps-serverwpmucdnis-a-geekscrysecfrom-txis-into-cartoonsmodelscapetrycloudflarelocaltonetstreak-linkbalena-devicesfrom-njforgeblocksfreebox-oswebadorsitefrom-ncdoesntexisthobby-sitestreaklinkshomesecuritymacownprovidertuleap-partnersdattorelaywphostedmailservequakeis-a-socialistservehalflifepivohostingdynuhostingquipelementsw-staticblitzdyndns-webfrom-deproject-studyis-not-certifiedhercules-devis-a-financialadvisoramazonlightsailservepicsis-a-greenloseyouripfrom-ilwithyoutubemwcloudnonprodwiredbladehostingdnsdojofrom-tnpixolinomyqnapcloudncloudstorageis-an-artisthostedpiis-a-landscaperauiusercontentoaiusercontenton-forgeis-a-conservativedreamhostersnet-freaksapps-1and1is-goneencoreapifastly-edgefrom-nesalesforcefrom-scdeployagentoraclegovcloudappsfrom-alis-a-lawyercechirevultrobjectsstufftoreadisa-geekddnsgeeklovableprojecttry-snowplowfrom-moblogsyteis-a-bookkeepernogmyforumravendbmyboxdeelementoredsaacficogoorinforgcomgobnatneteduidstoreorgcomnetintedudevnomepublorgcomneteduathgovtestscalculatorspaynowinfoquizzesresearchedcloudnsfunnelsassessmentsjscaleforcetmacltdorgmilcompronetgovbizpresseklogesrsccloudcustomfltusrcloude4corealmgovmunicontentproxy9metacentrumdyndyndyndnsdynpagespages-researchitionoccustomercomymyspreadshopipv64diskussionsbereich4limacomrubgov2ixfirewall-gatewayddnssspdnsbarsykeymachinesquare7myhome-serverspeedpartnercommunity-proschuldockxenonconnectgünstigliefernbwcloud-os-instancedyndnssecmy-routerxn--gnstigliefern-wobin-butterl-o-g-i-nisteingeekin-dslin-berlinin-brbfuettertdasnetzleitungsenin-vpnlcube-serverdyn-ip24logoipdyn-berlinruhr-uni-bochum12hpgoipsrvdnsfruskygit-repossvn-reposinternet-dnsgünstigbestellenhome-webserverxn--gnstigbestellen-zvbbplacedheimdnscosidnswebspaceconfiglima-citydyndns1istmeinvirtualuserschulplattformmy-gatewayddnsseclebtimnetztest-iservmein-iservvirtual-userhome64iservschuletaifun-dnstraeumtgeradeschulserverdynamisches-dns123webseitednshomehs-heilbronndnsupdaterbssgraphicdwadpdwdaepeweaawapaafpfwfabwbpbacwcpcciwebuserapiobjects*teamst3r2lpabymebravepanelngrokiservstglclcrmerpflypagesbarsyvivenushoplocalcertlocalplayerbearbloggatewaydeno-stagingis-not-ais-a-goodbotdashvercelmocha-sandboxplatter-appreplitgithubpreviewworkersinbrowserevervaultis-ahrsndenoxmitmodxmyaddrstorageapipayloadgrebedocruncontainersstgstagelclstageloginlineis-a-fullstackcodepenleapcellngrok-freeis-coolpagelemonstoragewebharemediatechlibp2pdiscourseimaginecomyspreadshopstoreregbiz123hjemmesidefirmcoorgcomnetedugovsldorgmilcomwebgobartnetedugovtmorgpolcomsocartnetedugovassoagrondiscoodontk12medcuegyecpaabgengorgmilgalsaltulcomadmesmgobpubdocmonfindgnriouioproartlatvetnetfotedulojgovntrturibrbarxxxofficialbasechefprofmktgpsictechinfoarqtcontdentrrpppsiqgit-pagesritmedfieorgcomlibprieduaipgovriikmeactvsportorgmilcomscieunnetedugovnameinfopintouchtawktotawkmyspreadshoporgcomnomgobedu123miwebcomputeorgcomnetedugovbiznameinfocognito-idptransfer-webappeusc-de-east-1onjelasticnxaspdnsbarsydirectwpdeuxfleurstransurldogadoprvwcloudnsamazonwebservicesdnshomeuserpartycokoobinmkmfidymyspreadshopalandkapsiikixn--hkkinen-5wacloudplatformhäkkinen123kotisivuidacorgmilcompronetedugovbiznameinforadioorgcomneteduuserexperts-comptablestmmyspreadshopgretaprdcomnomynhccifbxoshuissier-justicenotairesaeroportfreeboxoson-webavocatassoportgouvkdnschirurgiens-dentistes-en-franceavouesfbx-os123sitewebveterinairechirurgiens-dentistespharmacienchambagrimedecinfreebox-osdediboxgoupilemszicpyicpvicppleysheezypagesedugovcnpyorgcomcybllcpvtnetedugovtnxonlineschooldaemond6atcopanelorgnetplybotdashstackitkaasorgmilcomnetedugovbizmodltdorgcomedugovcoorgcomneteduappwriteacorgcomnetedugovcloudtranslateusercontentorgcomnetedumobiassoorgcomnetedugovbarsysimplesitediscourseindorgmilcomgobneteduorgcomwebnetedugovguaminfonxhra教育敎育網絡网絡组織組織网络網络组织組织公司政府個人个人箇人ltdorgcomincneteduidvgovxn--uc0ay4axn--55qx5dxn--mk0axixn--io0a7ixn--uc0atvxn--zf0avxxn--lcvr32dxn--od0algxn--wcvs22dxn--gmqw5axn--od0aq3bxn--mxtq1mxn--ciqpnxn--tn0agxn--gmq050iorgmilcomgobneteduiservwp2tempurlmircloudfreesitewpmudevmyfastgadgetcloudaccessjelehalfboltfastvpsemergenteasypanelopencraftizcombrendlynamefromrtpersoadultmedorgpolrelcomproartnetedufirminfoassoshopcoopgouvtmcomediahotelforumvideosportorgsexagrargameslakaseroticaerotikatozsdereklamcasino2000filmsuliinfoboltshopprivnewsszexcityutazasjogaszkonyveloingatlaneacaicogoormyᬩᬮᬶmilwebschnetkopbizzonedesaponpesxn--9tfkymyspreadshopgovmytabittabitorderravpageaccok12idforgnetgovmuniltdplcaccotttvorgcomnetmeca6g5gpgamubacaicniocoukuptverdruscsdelhiindorgmilcomwebnicfingenpronetintedugovresbizbiharbarsyinternetbusinessschooltravelsupabasealumnigujaratfirminfoaeropostbankcoopindevscloudnsno-ipbarsybarrell-of-knowledgebarrel-of-knowledgensupdategroks-thisdnsupdatefor-ourknowsitalldvrcammittwalddynamic-dnsv-infowebhopselfipdyndnshere-for-moreilovecollegemayfirstforumzcloudnsmittwaldservertypo3servergroks-theeusekd1cdndyndnsidrawsainaueuapjpusstagemocksysdevicesclientcustreservdcustdevdisrecprodtestingcobeebyteutwenteboxfusebravepstmndedynngrokorgmilcomnomnetedugovqcxqzzbarsythingdustmo-siemensrb-hostingfh-muenstergitbookbluebitecloudbeesusercontentnodeartkiloappsforgerockdarklangresinstagingapigeebubbleb-datascryptedhypernodedappnodepantheonsitegitlabgithubkeeneticvirtualservercleverappshostyhostingon-rioedugitticketstelebitwixstudioon-k3sicp0icp12038jeleqotolairbubbleappsmyaddrstolosmyrdbxwebflowdrive-platformbeagleboardhasura-applolipopdefinimavaporcloudmusicianwebflowtestazurecontainerresindevicereadthedocsloginlineeditorxmoonscalesandcatsbasicserverwebthingsbrowsersafetymarkbeebyteappbitbucketidaccovistablogorgschnetgovxn--mgba3a4f16axn--mgba3a4fraarvanedgeايرانایرانjclaspeziapdudcefegelemeperetevebacanatavaparasabgagfgogrgpgalclblimfmrmcbmbvbfclcmcvcrcpcchlimifibicivipirisimncnbnanenrnpntnnolomobocoaogorosopotoptvtatctbtmtltotpusulunutpspapaqsvpvvvtvavvrtrsrprgrfrcrbrarorkrvstsssbscsmsispzczbzbozen-suedtirolmyspreadshopxn--bulsan-sdtirol-nsbxn--valledaoste-ebbtrentinoaltoadigetrentin-sued-tirolxn--forlcesena-c8axn--forl-cesena-fcbxn--bozen-sdtirol-2obtriestetrentinsuedtiroltrentino-s-tirollecceudineaostesienaparmaluccapaviagenoapaduaaostamonzaabruzzoternirietiturinmilanbozenlaziofermoleccocuneonuoropratola-speziavdataaligfvgpugmolcalcamlomumbsicpmnvenvaoedugovabrsarmaremrbastoslazibxosfirenzetrentinosüdtirolval-d-aostavalle-aostamessinacremonaravennatoscanatrentin-suedtirolbolognacalabriaurbinopesarofriuli-v-giuliaogliastraxn--valle-aoste-ebblaquilaandriatranibarlettasyncloudxn--valle-d-aoste-ehbaostavalleyvalled-aostatrentino-alto-adigevallee-d-aostexn--balsan-sdtirol-nsbpistoiasicilialucaniacataniaiserniaperugiabresciaveneziagorizialiguriaimperiabulsan-suedtirolbalsan-suedtirolbarlettatraniandriaxn--trentino-sdtirol-szbforlì-cesenatuscanyvallée-d-aostemantovavallée-aostecasertapiemontevalleaostaval-daostafriulivgiuliatrevisoforli-cesenavalléedaosteferrarapescaravald-aostatrentino-altoadigefriuli-vegiuliavallee-aostecarboniaiglesiastarantomediocampidanovalleedaostetrentinosud-tirolcampobassotrentinsüd-tiroltrentinosüd-tirolmonzabrianzatrentino-südtirolxn--trentino-sd-tirol-c3bpotenzacosenzavicenzaemiliaromagnavenicefrosinonemarchepordenonetrentinosued-tirolvaresemolisevalléeaostefriuli-veneziagiuliabasilicatalatinaanconasavonaveronamodenabiellabolzano-altoadigepugliafoggiaumbriatrentino-stirolgenovapadovamateranovararagusapiacenzatrentinostirolvalleeaostetempio-olbiasudsardegnatrentinsudtirolmassa-carrarafriuliveneziagiuliatrentinosuedtirolandria-barletta-tranitrapanixn--cesenaforl-i8amaceratacaltanissettaascoli-picenobrindisicarraramassacagliaririmininapolivibo-valentiachietibulsan-sudtirolbalsan-sudtiroltrentino-a-adigebulsanbalsaniglesiascarboniamilanotorinoteramodell-ogliastraarezzotrentinoalto-adigerovigotrentovenetoiglesias-carboniatrentino-sud-tirolaltoadigereggio-emiliareggio-calabriasardegnatranibarlettaandriapiedmontxn--sdtirol-n2amedio-campidanotrentino-süd-tirolfriuli-vgiuliafriuli-ve-giuliaromeennaromapisa32-b16-b64-blodiastibarineencomonaplesforlicesenailiadboxosalessandriasicilytrani-barletta-andriaxn--trentin-sdtirol-7vbpesarourbinotrentinsued-tirolcesena-forliforlìcesenaemilia-romagnamonzaebrianzaxn--trentinsdtirol-nsbtrentinos-tiroltrentinsüdtirolvalledaostaolbia-tempiocampidanomediovibovalentiasassarivalle-daostalombardysud-sardegnafriulivegiuliareggioemiliamonzaedellabrianzaalto-adigevercellitrentin-sudtiroltraniandriabarlettatrentino-sudtirolascolipicenobozen-südtirolfriulive-giuliaflorencexn--cesena-forl-mcbcarbonia-iglesiasaosta-valleycarrara-massadellogliastratrentinoa-adigexn--valleaoste-e7apesaro-urbinoxn--trentinosdtirol-7vbxn--trentin-sd-tirol-rzbxn--trentinsd-tirol-6vbtrani-andria-barlettatrentin-süd-tirolxn--trentinosd-tirol-rzbgrossetomonza-e-della-brianzasüdtirolreggiocalabriatrentinoaadigetrentin-südtirolverbano-cusio-ossolafriuliv-giuliaverbaniacampaniatrentino-aadigefriulivenezia-giuliasardiniaandriabarlettatranibarletta-trani-andriacatanzarooristanourbino-pesarocesena-forlìvalle-d-aostacampidano-medio123homepagesiracusatempioolbiasuedtirollombardiaavellinocesenaforlìtrentinofriuli-venezia-giuliabozen-sudtirolandria-trani-barlettabulsan-südtirolbalsan-südtirolmonza-brianzabolzanotrentino-sued-tirolbellunosalernolivornocrotonesondriodnshometrentinsud-tirolmassacarraratrentin-sud-tiroltrentino-suedtirolviterbobergamocesenaforliolbiatempiopalermobeneventoagrigentoofcoorgnetfmaitvphdengorgmilcomschnetedugovperagrikanieasukehandachitatokaiaisaikonanoharuamaobuhigashiuraowariasahiinuyamatobishimaiwakurashitarainazawatoyonegamagorimihamatoyotataharakariyayatomioguchikomakimiyoshinishiotokonamekiyosuchiryutoyohashiokazakiisshikikasugaikotakiratoeianjotogofusosetohazutsushimashinshirotakahamanisshinshikatsuhekinantoyokawaichinomiyatoyoakeodateogataakitaikawakyowahonjoogayurihonjonoshirokamiokakatagamimitanegojomeyokotekosakadaisenkazunonikahohonjyomoriyoshimisatohappoukamikoanihachirogatahigashinarusesembokufujisatokitaakitaitayanagiowanitakkomutsutsurutahirosakigonoheoirasetowadamisawanohejiaomorishingohiranairokunohehashikamitsugarushichinohehachinohenakadomarisannohekuroishisakaeisumiasahiotakiinzaiabikomatsudoyachiyomutsuzawakujukuriomigawakashiwatoganemihamanaritasakuranagaramobarahanamigawachoshishiroichoseikozakishisuikatorimidorichonankyonanfuttsuonjukufunabashinagareyamanodasosatakochuotohnoshourayasukimitsuyokaichibayotsukaidosodegauratateyamakamagayayokoshibahikariyachimatakatsuuratomisatokisarazukamogawaichikawanarashinoichinomiyashimofusaminamibososhirakoichiharaoamishirasatoikatahonaiainansaijoseiyoiyoozuuwajimaniihamanamikatamasakiuchikokihokutobetoonshikokuchuomatsuyamaimabarikamijimakumakogenyawatahamamatsunosabaeikedaobamasakaifukuiohionotsurugamihamawakasaminamiechizeneiheijikatsuyamatakahamaechizensoedaukihaomutaokawanishiogoribuzenonojosueumiokiotochikugosasagurisaigawamizumakishinyoshitomikurumekurateyamadakasuganakamamiyamanogatatakatahakataiizukakawaratagawakasuyaashiyainatsukimunakataminamitsuikishonaikurogifukuchikeisenhigashimiyakoshinguyukuhashiokagakiyamekogaongausuikahotohochuotoyotsumiyawakadazaifuhisayamatachiaraiyanagawanakagawahirokawachikujochikushinochikuhochikuzennamieotamaokumashowateneiiwakikoorinangoononishigoshimogoomotegomishimafukushimaasakawakagamiishishirakawaiitatefutabahiratayugawahanawakitakatakawamatakunimiyabukibandaihigashihironoyamatomiharuyamatsuriaizubangedatesomaaizuwakamatsuyanaizuaizumisatonishiaizuizumizakikitashiobarataishinkaneyamakoriyamainawashirotanagurafurudonosamegawasukagawaishikawatamakawaikedaogakitaruiginanenahashimahichisonakatsugawaibigawashirakawamizunamiminokamomitakekawauesekigaharatomikasakahogikitagatayamagatatajimianpachimotosuyaotsukakamigaharahidakanisekitokigujominogodoyorogifukasamatsutakayamawanouchihigashishirakawakasaharashimonitatsumagoichiyodakannakanrashowameiwakiryuotaoratomiokafujiokaitakuranaganoharahigashiagatsumatakasakishibukawaminakamikatashinatsukiyonokawabanumataannakaoizumimidorishintoisesakiuenoyoshiokakusatsutakayamanakanojonanmokutamamuratatebayashimaebashiotakekaitadaiwahongofuchukuietajimashobaramiharahatsukaichihigashihiroshimamiyoshikumanokurenakasakaseraseranishiasaminamifukuyamashinichionomichiosakikamijimajinsekikogentakeharaotobenanaeikedatohmaozoraobiraabirakyowaeniwataikibibaisharirebunerimohiroooketootarupippunishiokoppechitosefurubirahakodateshiranukakitahiroshimakushiroobihironanporoiwamizawaniikappukunneppufukushimanakasatsunaitoyourakuromatsunaiakabirakamisunagawashibechaurakawakamifuranonakatombetsuasahikawashimokawakayabeokoppebiratoriabashirisaromaatsumanumatahidakabifukamukawamikasahorokanaitoyotomisarufutsuhigashikawaishikarikitamiyoichiesashiiwanaitomariminamifuranoakkeshifuranotoyakoyakumootoineppushikaoishiraoinemuronayorohaboroashorobihororishirifujiutashinaihokutotakasuebetsuurausuassabukikonaishimamakinaiedatetoyabieinikiesanuryuoumuteshikagarikubetsuashibetsukimobetsuaibetsutobetsusobetsuembetsushimizuchippubetsurishirihokuryuhoronobeshintokutsubetsushibetsuhonbetsumombetsutsukigatakuriyamakoshimizushiriuchikutchanmurorannoboribetsukamishihorowassamushinshinotsukembuchiwakkanaikamoenaikiyosatotakinoueshikabesunagawafukagawanakagawatakikawakamikawahigashikagurahamatonbetsumatsumaemoseushirankoshishakotanimakanemashikeotofuketomakomaisandatambaitamiawajikasaiasagoshisoonoakoyashirotoyookaminamiawajiinagawafukusakitakasagokamigorikasugaharimayokawaashiyahimejiakashitaishiaogakisannantakinosumototakarazukanishinomiyashingugoshikinishiwakiyokatakaaioimikisayoyabukawanishiamagasakisasayamashinonsenkakogawaichikawakamikawatatsunotsukubaiwamaogawaasahisakaitokaioaraiitakobandodaigosuifuinaamikasumigaurakashimaomitamayachiyoshimodatetomobetoridehitachinakainashikisakuragawakasamayawaramoriyahitachiomiyanamegatayamagatahitachikamisuushikutakahagiibarakitonekoganakasowayukimihojosomitoryugasakishimotsumafujishirotsuchiurachikuseihitachiotashirosatotamatsukuriuchiharashikahakuinanaotsubatawajimakahokukawakitatsurugikaganominotosuzuuchinadakomatsuanamizunakanotohakusannonoichikanazawaiwateshiwafudaikawaimoriokaofunatohanamakikuzumakikitakamininohekunoheyamadayahabasumitaichinosekitanohatahiraizumirikuzentakatajobojiotsuchihironomiyakoiwaizumikarumaiichinohenodakujitonooshushizukuishifujisawamizusawakamaishikanegasakimannoutazukotohiraayagawazentsujihigashikagawauchinomikanonjisanukimarugamemitoyotakamatsutadotsunaoshimatonoshoakuneamamiizumihiokiyusuikinkoisasookouyamanakatanekagoshimakanoyaisenkawanabeminamitanemakurazakitarumizunishinoomotematsumotosatsumasendaioimatsudaayaseebinamiurazushinakaiodawaraiseharasagamiharahakoneaikawakaiseiatsugitsukuihadanoyamatoyamakitazamaoisochigasakininomiyayokosukakamakuraminamiashigarafujisawasamukawakiyokawahiratsukayugawaraokawaumajikochitsunootoyoakiinonishitosayasudahidakamiharasakawaniyodogawahigashitsunokagamigeiseisusakiotsukinaharisukumomurototosakamiochitoyotosashimizumotoyamanankokunakamurakitagawayusuharaogunichoyoukiasoutoozugyokutoamakusamifunetakamoriyamagaminamataminamiogunikikuchisumotoyamatonagasumashikiaraokumamotokamiamakusanishiharayatsushiroayabeseikasakyoideineujinakagyokameokakyotangokyotanabekyotambaminamiyamashiroyamashinatanabeyawatawazukaminaminantanmiyazuhigashiyamafukuchiyamakitamukokamojoyokizumaizuruujitawaraoyamazakinagaokakyokumiyamakawagoeinabeshimameiwaasahitaikiudonoisetsukisosakikuwanamihamamiyamasuzukatamakimisuginabarikumanokomonominamiisewataraitobakiwatakikihotadomatsusakayokkaichikameyamaureshinoishinomakishichikashukuohirataiwaosakizaohigashimatsushimashikamaiwanumashibataogawaraonagawakawasakiseminemarumoriminamisanrikukakudamuratawakuyatomiyanatoriwataritagajomisatotomekamirifushiroishimatsushimayamamotoshiogamafurukawahyugaebinotsunosaitoayakushimanobeokakitauramiyazakitakazakigokaseshiibamimatashintomikunitomikitakatakobayashikawaminamitakaharukijotakanabemiyakonojonishimeranichinankitagawakadogawamorotsukakisofukushimaminamimakisakaeobuseikedaogawamiasaokayaasahiotakiotarichinoinaomichikumakomaganechikuhokukaruizawayasuokaooshikaikusakaminamiaikitogakushimatsukawakawakamitateshinatakamorikitaaikishiojirimiyadahakubaiizunaiijimaiiyamamiyotasuzakayasakatoguraookuwanagawaminowahirayayamagataminamiminowafujimiomachisakakitakaginaganonakanosakuhokomoronagisoshinanomachiwadauedaiidaharasuwatomiachiaokianankisosakunozawaonsenagematsutakayamashimosuwamatsumotoyamanouchinakagawamochizukiazuminotatsunoobamaomuraseihiunzenosetofutsuikichijiwanagasakiisahayahasamisaikaikawatanasasebohiradokuchinotsugototogitsutsushimashimabarashinkamigotomatsuurayamazoekashibaikomakawaitenrioyodosangokoryoudaojiikarugayamatokoriyamatenkawakatsuragikurotakikawakamimiyakemitsuetakatorikamikitayamayamatotakadahegurishinjokanmakisakuraitawaramotogoseoudanarasoniandokawanishishimoichihigashiyoshinokashiharashimokitayamanosegawayoshinomintsivorytopazsakuragehirnsumomoaseinetopalmail-boxmokurenyoitamuikaojiyagosensanjoaganomyokoseiroagaomishibataniigatanagaokamurakamiuonumayuzawakariwatagamitainaitsunanminamiuonumatochioyahikojoetsuseiroukamosadoizumozakitokamachiitoigawasekikawakashiwazakitsubamemitsukekokonoesaikiusukibeppuusahimeshimakunisakihasamataketatsukumihitaoitahijikusuyufukujukamitsuebungoonobungotakadaibaraniimibizentsuyamaokayamakasaokahayashimayakagemaniwaakaiwamisakishinjotamanotakahashikibichuowakesojanagishookumenannishiawakurakurashikiasakuchisetouchikagaminosatoshotomigusukunakagusukuyaeseizenaurumaiheyaaguniogiminanjokinminamidaitokitanakagusukuyonaguniokinawaishigakikunigamiurasoekadenataramahiraraginozataketomishimojizamamitonakiitomanhigashimotobuyonabarugushikamionnanahanagohaebarukumejimakitadaitonakijinnishiharayomitanginowantokashikiishikawaikedasuitaminohizuminishisakaikananabenodaitoosakasayamayaokishiwadatadaokakaizukatondabayashichihayaakasakakumatorikadomasayamahigashiosakashijonawatehirakatataishimisakitajirihannansennankatanotoyonominatosettsuhigashiyodogawaibarakinosekitachuohigashisumiyoshifujiiderakashiwaraizumiotsutoyonakamatsubaramoriguchiizumisanoshimamototakatsukineyagawahabikinotakaishikawachinaganoyoshinogarikamiminearitaouchiimarihizenogikashimaariakekiyamafukudomikitagatakitahataomachigenkaikanzakinishiaritakyuragisagataratosutakushiroishikaratsuhamatamakouhokukawagoeyoshidasatteogoseirumaasakaurawaogawaniizaomiyayoriiotakishikihonjooganohannohanyuinasaitamaokegawaarakawayoshikawayokozehasudasayamahidakafukayachichibuiwatsukiryokamiyoshimikamiizumifujimiwarabiranzanmiyoshiminanoyashiosakadosugitomisatohigashichichibutodasokakukiyonokazoshiraokakasukabekounosukawajimatsurugashimamiyashirokitamotohatoyamamoroyamahatogayakumagayakawaguchinagatorokamisatomatsubushinamegawatokigawakamikawafujiminohigashimatsuyamakoshigayatokorozawas3isk01isk02ryuohkoseikonanaishorittotakashimamaibarahikonetorahimenishiazaikokagamokotoyasuotsukusatsunagahamamoriyamatoyosatotakatsukinotogawaomihachimanhigashiomiakagiunnanizumogotsuamayatsukakakinokimatsuehamadamasudahikawahikimiokuizumoyasugiyakumomisatotamayuohdahigashiizumookinoshimanishinoshimatsuwanoshimaneshimadafujiedayoshidashimodagotembaiwataatamikosaiyaizuitoizumishimahaibaramakinoharaomaezakikawanehonkannamisusonohigashiizufukuroinumazukawazufujiaraishizuokahamamatsushimizuizunokunimatsuzakimorimachiminamiizunishiizukikugawakakegawafujikawafujinomiyaujiietsugaoyamayaitaohiranikkoashikagakuroisokanumasakurashioyakarasuyamamotegiichikaikaminokawatochigihagamokanogisanobatonasumibunasushiobaranishikatautsunomiyaiwafunemashikoshimotsukeohtawaratakanezawaitanokomatsushimatokushimaichibaminamiaizumiwajikikainanmiyoshinarutomimamugiananmatsushigesanagochishishikuinakagawamachidachiyodakomaefussainagitaitochofufuchuomeotahigashiyamatotoshimaokutamaaogashimakodairaedogawaarakawahachiojishinagawatachikawashibuyasuginamihinodekiyosesumidaoshimanerimamitakahamuraadachinakanomizuhobunkyomegurominatokoganeihigashikurumekokubunjihigashimurayamamusashimurayamatamakitahinochuokotokatsushikakouzushimaogasawaraakishimakunitachishinjukusetagayamusashinohachijoitabashiakirunohinoharachizunanbukotouramisasawakasayonagokogehinoyazutottorinichinansakaiminatokawaharaoyabetairainamiasahinantoimizufuchutakaokakurobeyamadajohanatoyamatonaminyuzenfunahashinakaniikawanamerikawaunazukitogahimiuozufukumitsutateyamakamiichiiwadearidayuasainamitaijikatsuragiaridagawatanabemihamahidakakainankiminomisatoshingushirahamakamitondayurakozakoyagobokitayamawakayamakudoyamahashimotokushimotokozagawahirogawakinokawanachikatsuurarsuseroeoishidasagaeoguniasahinagaitendonanyoobanazawanishikawasakataohkuratozawamikawamamurogawayamagatafunagatatakahatashonaishinjokahokuiideyuzakawanishitsuruokakaminoyamayamanobeshiratakamurayamanakayamakaneyamahigashineyonezawasakegawamitouubeyuuabushimonosekitabuseoshimatoyotaiwakunihikarishunannagatohagihofukudamatsutokuyamashowadoshitsurunanbukoshukaiminami-alpsnirasakikosugeotsukioshinohokutominobuyamanashifuefukichuokofuichikawamisatoyamanakakonakamichitabayamanishikatsuranarusawafujikawahayakawafujiyoshidafujikawaguchikouenohara長野京都岐阜大阪三重群馬千葉滋賀佐賀奈良adednelgaccogogror秋田愛知高知埼玉沖縄栃木熊本岩手青森山梨新潟島根鳥取長崎香川宮城石川大分宮崎茨城山口兵庫山形徳島広島福島福岡岡山富山静岡愛媛福井東京xn--4it168dhatenadiaryxn--vgu402ckawaiishophatenablogcocottenamaste北海道penneehimeiwateversestabachibashigagonnagunmapermahaccaakitaosakauh-ohblushkochiaichifukuikuroncapooitigohyogotokyokyotopunyuthickcheap0t00g00j0mie2-ddaapyawjg0amfemsubxiiboomoobutchueekpgwrgrherskrboyrdyupperunderflierchipsmydnsheavyangryhippygirlyrulez神奈川鹿児島和歌山bambinaxn--nit225kokayamasaitamaxn--k7yn95exn--1lqs03nsapporoparasitelolipopmcxn--efvn9sniigatafukuokatokushimafukushimahiroshimakagoshimafakefurokinawaxn--8pvr4ucoolblogxn--0trq7p7nnkawasakinagasakimiyazakichilloutxn--8ltr62kxn--klty5xpeeweezombiecutegirlxn--rny31hxn--uuwu58axn--ntso0iqx3axn--djrs72d6uytoyamanikitanyantakagawamimozanagoyaboyfriendxn--2m4a15egreaterchowderegoismyamagatafashionstorexn--elqq16hxn--pssu33lsendaimiyagixn--rht27zpecoriaomorisaloonwatsonvivianxn--djty4knobushipigboatnaganopinokoxn--f6qx53asadistvelvetsecretxn--5js045dchicappayamanashiibarakidigickgirlfriendxn--1lqs71dmongolianxn--c3s14mxn--qqqt11mtochigixn--5rtq34kparallelo0o0mondkobesagabonadecaoitanarafoolkilldecimainhiholomosblokilociaoundopupugifutankcrapflopnooroopsmodsholyjeezstripperpepperbittershizuokaxn--rht3dkitakyushureadymadeicurusversusmatrixxn--rht61ehungryfloppygloomycrankyhandcraftedlittlestarxn--klt787dxn--kltx9awhitesnowsunnydaytottorilovepoptheshopbuyshopxn--5rtp49cxn--d5qv7z876cwebaccelxn--kbrq7oxn--4pvxsxn--1ctwolovesickkumamotocatfoodxn--tor131oyokohamawakayamatonkotsuxn--ehqz56nxn--uist22hxn--6btw5axn--kltp7dyamaguchifrenchkisspussycatxn--4it797kxn--uisz3gbabybluexn--zbx025dnetgamersxn--7t0a264ckanagawaxn--6orx2rishikawaxn--ntsq17ghalfmoonschoolbusjellybeanxn--mkru45iusercontentlolitapunkxn--32vp30hsakurastoragehokkaidoshimanecandypopbabymilksupersaleweblikeraindropbackdropwebsozaikikirarahateblodaynightmeneacsccogoormobiinfoaeusxxorgmilcomnetedugovorgcomnetedugovbizinfotmprdorgmilcomnomedugovassnotairespresseassocoopgouvveterinairemedecinpharmaciensorgnetedugovtraorgcomedurepgovmeneperekgacscaiiocogoitoresmshsseoulbusanulsandaeguc01milvkimmvchungnamjeonnamjeonbukeliv-dnsgyeonggijejueliv-cdnincheondaejeongangwongyeongbukgwangjuchungbukgyeongnameliv-apicoeduindorgcomembnetedugovorgmilcomnetedugovjcloudorgcomnetintedugovperbnrinfocooyorgcomnetedugovethipfscanvamypepethw3sstorachakeeneticjoinmcinbrowserdwebcyonnftstoragemyfritzaemewphlxachotelltdorgcomwebsocschngonetintedugrpgovassnomgacsccoorgnetedugovbizinfo123websiteidorgmilcomasnnetedugovconfidmedorgcomplcschnetedugovaccoorgnetgovpresstmassoirseproxaccosoundcasthoptocraftvp4c66orgnetedugovitsmcdirmyboxbarsyedgestacksynologylogintoopencloudnohostwebhopdiskstationi234tcp4hoocgroknoipprivmydsddnsdnsforlohmustransipdscloudfilegear-sgbrasiliafilegearframerbarsybarsyonlinecoprdorgmilcomnomedugovinforgcomnetedugovnameacprorgcomartnetedugovpresseinfoassoinstgouvorgnycedugovbarsydscloudjuorgcomnetedugovminisiteaccoororgcomnetgovorgmilcompronetintedugovbizmuseumnameinfoaerocoopaccoorgcomnetintedugovbizcooporgcomgobneteduorgmilcomnetedugovbiznameaccoorgmilneteduadvgovcoorgcomnetaltgovforgotherhiskeeneticispmanagernomassoprod5476132eastasiacentraluswesteuropewestus2eastus2pnortheurope-01newzealandnorth-01southindia-01southcentralus2-01norwaywest-01eastus2-01westus2-01australiaeast-01italynorth-01israelnorthwest-01swedencentral-01westeurope-01centraluseuap-01taiwannorthwest-01uaecentral-01northcentralusstage-01israelcentral-01mexicocentral-01canadacentral-01austriaeast-01germanywestcentral-01francecentral-01ukwest-01denmarkeast-01polandcentral-01eastus-01westus-01swedensouth-01eastus3-01westus3-01brazilsouth-01centralus-01francesouth-01australiacentral-01westindia-01uaenorth-01jioindiacentral-01canadaeast-01belgiumcentral-01spaincentral-01koreacentral-01chilecentral-01qatarcentral-01westcentralus-01eastus2euap-01norwayeast-01southafricanorth-01brazilsoutheast-01germanynorth-01switzerlandnorth-01switzerlandwest-01japanwest-01southafricawest-01japaneast-01eastasia-01indiasouthcentral-01taiwannorth-01centralindia-01uksouth-01southcentralus-01northcentralus-01eastasiastage-01indonesiacentral-01australiacentral2-01australiasoutheast-01malaysiawest-01koreasouth-01southeastasia-01southeastus5-01northeastus5-01jioindiawest-01rucdnwest1-usfra1-desandboxjls-sto1jls-sto3jls-sto2aglobalabglobalsslmapprodfreetlsmapvpslon-1lon-2ny-1fr-1sg-1ny-2paassnwebpaashostingjelasticnordeste-idcsocuserpagescwebfileblobservicebuscoreatlricnjsjelasticwebsitestoragesezagbinruhuukjptsmyspreadshopmynetnameakamaiorigin-stagingfrom-coipv64dynv6cdn77serveblogadobeaemcloudhicamsprytdnsupno-ipownipde5ovhicpfirewall-gatewaysytesmypsxbarsyusgovcloudapimyamazemyradwebakamaihdsaveincloudfastlylbfrom-lasubsc-paysquare7in-the-bandblackbaudcdnhomelinuxoninfernoctfcloudservebbsdns-dynamiccloudfrontakamai-stagingipifonyham-radio-opsenseeringclickrisingcommunity-profrom-nylocalcertgrafana-devedgesuite-stagingcloudflareanycasteating-organicatlassian-devmydattofeste-iplocaltotorprojectknx-serveredgekeycloudflareglobalcloudyclustercasacamserveftpakamaized-stagingakamaiorigindns-cloudmyeffectboomlabotdashbuyshousestwmailhetemlazure-mobilein-dslthruhereredirectmedynuddnsbouncemesupabaseluyanicloudappakamaicloudfunctionsdebiannhlfanpgafanstatic-accessin-vpnmysynologymafeloappudohomeftptrafficmanagersiteleafseidatmemsetcloudflarecloudaccesskeyword-onazure-apiis-a-chefdoes-itgets-itwebhopselfiphomeipkicks-assedgesuitewindowsserver-ontunnelmolemydissentscrapper-sitecloudflarecnuni5srcfggffiobbzabchrsndenodynuopikddnsvpndnsakadnselastxkinghostvps-hostfastlyhomeunixazureedgeshopselectdontexistmyfritzcloudjiffyalwaysdatasells-itsquaresbroke-itazurefddattolocalat-band-campmeinforumfamilydsazurestaticappsdefinimabplaceddnsaliasdynaliasnow-dnsblogdnsroutingthecloudendofinternetdsmynasakamaiedgemymediapcadobeio-staticakamaiedge-stagingakamaihd-stagingddns-ipprivatizehealthinsurancelive-onkrellianschokokeksmassivegridmysecuritycamerarackmazeserveminecraftfrom-azis-a-geekakamaizedmoonscaleoffice-on-theusgovtrafficmanageradobeioruntimeedgekey-stagingreserve-onlinechannelsdvrdnsdojousgovcloudappcdn77-sslapps-1and1podzoneazurewebsitesdynathomescaleforceyandexcloudvusercontentisa-geekcdn-edgescoaemalcesappwriteazimuthtlonarvobuiltwithrocketnoticeablestorecomwebrecnetperotherfirminfoartslgdloncogoiltdorgmilcolcomplcschgenngonetedugovbiznamefirmmobiacincoorgmilcomnomwebgobnetintedubizinfocomyspreadshopdemongovtransurl123websitehosting-clusterkhplaycistrongsnesosvalervålerxn--vler-qoaossandeheroysandeherøybøboheroyherøyxn--hery-iraxn--b-5gavalerbøboxn--b-5gasandesandexn--hery-iraxn--vler-qoavålerhåreålaahavaofsfvfhlolnlalrlhmfmtmahcostntbuåstrmreigersundmyspreadshopgálsáeidsvolltingvollgildeskalflorøvadsøvardøvanylvenxn--bhccavuotna-k7astrandaxn--kvnangen-k0axn--sknland-fxaxn--mosjen-eyarakkestadhyllestadnannestadvevelstadvaapstenordre-landsondre-landsøndre-landtjieltexn--vrggt-xqadsør-aurdalsor-aurdalheradstordmoldefordeførdeseljefedjeryggehemnexn--krehamn-dxasognegranesøgnebrynetjomevallebykletokkegiskedovretjømehobølvoldasaudatolgasømnaviknadønnasomnadonnatranafrananesnaraumasmolatrænafrænalesjasmølaørstaorstahitrafloraaukraloppafrøyarissasnasahalsagalsaromsaraisaráisafroyasnåsagronghobolfjelltydalårdalardalaskimharamkraanghkekråanghkesorumbarumhurumbærumsørummodumsálátbálátfrognbjugnvåganvagangulenskienløtenlotenstrynvefsnxn--merker-kuaskaunsveiobømlobomloskjåkvardoflorovadsosalatbalatsálatklæbuklabuselbubarduulvikskjakklepprisørxn--nttery-byaeflåeidflahofmilgolholsellomskifetvikdepvgsfhsaskerrisorhamarasnesåsnesrørosrorosxn--slat-5namasoynaroyvaroyluroydyroyaskoyradoyandoyrodoymeloyradøyandøyrødøymeløyaskøylurøydyrøymåsøyværøynærøyhoylandethøylandetdivtasvuodnalørenskoglorenskognesoddtangenxn--tjme-hraxn--smla-hraxn--stjrdal-s1aunjargalillehammerunjárgaxn--hamary-fyadavvenjargaxn--bearalvhki-y4a123hjemmesidegjerdrumxn--brnnysund-m8acxn--tnsberg-q1axn--mlatvuopmi-s4axn--snsa-roaxn--skierv-utaxn--brum-voatysfjordkvafjordeidfjordkvæfjordsongdalenmjondalenmjøndalenxn--gls-elackragerogáŋgaviikagangaviikasørreisasorreisasør-varangersor-varangerxn--risr-iraskiervaxn--frna-woaxn--trna-woakvinesdalleksvikleirvikrøyrvikroyrviksvelvikvenneslaevje-og-hornnessandnessjøenmarnardalvindafjordsandefjordenebakksnillfjordullensvangxn--trany-yuabrønnøysundnamsskoganaustevollxn--stjrdalshalsen-sqbnord-aurdalnord-frontrøgstadtrogstadgrimstadflakstadgjerstadxn--sandy-yuaxn--leagaviika-52bnore-og-uvdalvegarsheixn--rlingen-mxaxn--ggaviika-8ya47hvegårsheikarlsoykvitsoymasfjordenhamaroyinderoyosteroydavvenjárgasauheradguovdageaidnuxn--vre-eiker-k8abronnoysiellakkrødsheradkrodsheradkvinnheradbrønnøyxn--mtta-vrjjat-k7afxn--lrenskog-54akvitsøyvárggátkarlsøyosterøyinderøyhamarøybronnoysundxn--aurskog-hland-jnbbahccavuotnabáhccavuotnagiehtavuoatnastor-elvdalmidtre-gauldalxn--gildeskl-g0akarasjokevenassixn--bievt-0qaxn--yer-znalebesbynessebyxn--hbmer-xqamalselvmålselvxn--unjrga-rtamøre-og-romsdalmore-og-romsdalhareidmelandørlandorlandstrandålgårdsolundalgardafjordåfjorddielddanuorrikautokeinoxn--stre-toten-zcbskodjeaejriestangeliernebamblestokkefauskesnåasesnaasekongsvingerlangevagberlevagxn--flor-jrahattfjelldalostre-totenøstre-totenvestfoldxn--mely-iraálaheadjualaheadjunordreisaxn--troms-zuaxn--lgrd-poacporsangerflatangerstavangerleikangerbremangersamnangergieldakarasjohkaxn--rdy-0nabfrostautsirasnoasatromsaxn--sr-aurdal-l8aflekkefjordjølsterjolsteraremarkhedmarknååmesjevuemienaamesjevuemiexn--vard-jrarollagmeråkermerakerorskogørskogxn--bdddj-mrabdákŋoluoktaxn--osyro-wuaaknoluoktatrysilskjervøymandaljondalbindalrindalmeldalsuldalorkdalsigdalalvdallærdalhurdalsirdalverdallerdallardaloppdalåseralaseralhadselkragerødivttasvuotnaoverhallasteinkjerxn--hnefoss-q1askedsmokorsettromsøxn--dyry-iravestre-totenmuseumxn--sandnessjen-ogbrahkkeravjufylkesbiblbájddarbajddarxn--laheadju-7yarennesøyxn--koluokta-7ya57hxn--hgebostad-g3aleirfjordstorfjordbalsfjordbåtsfjordbatsfjordmuosátbievátloabátkárášjohkanøtterøyxn--mjndalen-64anordkappláhppilahppialstahaugsiljanverranrøykenroykenhaldenlyngenbergenhortenhønefosshonefosstroandinbeiarnvarggatosoyroosøyrotromsoidrettmuosatbievatruovatloabatvoagattynsetnessetxn--indery-fyaskánitskanitraholtråholtxn--ystre-slidre-ujbandebusarpsborgbearduxn--karlsy-fyahordalandjorpelandjørpelanddeatnuringsakersør-odalsor-odalxn--slt-elabringerikeaudnedalnittedalnissedalhemsedalslattumsurnadalxn--blt-elabelverumstjørdalnaustdalhjartdalgjøvikfyresdalhasviknarviklarvikgjovikmalvikgamviklenvikporsgrunnstjordalengerdaldrobakdrøbakxn--msy-ula0hvestvagoyxn--vgan-qoaxn--ryken-vuaxn--lten-graxn--stfold-9xaxn--hpmir-xqaxn--lury-iramálatvuopmimalatvuopmitysværkirkenesbirkenesmoskenesbáidárxn--fjord-lraxn--rdal-poabahcavuotnabáhcavuotnaxn--frde-gralindåsbearalvahkixn--hobl-iraráhkkerávjuxn--loabt-0qavågåáltábodøsundlundraderådeetnetimeholeauregrueoddavagavegaranatanaarnasolasulaaltalekafusavangbergkvamåmliamlibokntinnroangranosenoslobodorøstroststatåmotamotivguprivøyeroyerliermossvossxn--nvuotna-hwalusterlunnermarkerhábmerhabmerhvalerfjalerxn--rholt-mratysvarbaidarfitjargaularhápmirhapmirmelhusfosnesøksnesoksnestysneshemnesevenesflesbergeidsbergtonsbergtønsberglindasxn--sndre-land-0cbnamsosxn--srum-graøystre-slidreoystre-slidrevestre-slidretrondheimbalestrandxn--langevg-jxaaustrheimxn--skjk-soavagsoyaveroysandoykarmoyfinnoytranoyvestbytranbysykkylvenxn--hyanger-q1aspjelkavikandasuoloxn--fl-ziaxn--drbak-wuastathellexn--sr-varanger-ggbtelemarkxn--bhcavuotna-s4axn--porsgu-sta26fčáhcesuolocahcesuoloakrehamnåkrehamnsandøykarmøyfinnøytranøyvågsøyaverøynamdalseidxn--lesund-huabadaddjaxn--vegrshei-c0axn--btsfjord-9zagildeskålporsanguxn--trgstad-r1anávuotnanavuotnahammerfestxn--sgne-graxn--brnny-wuacibestadharstadnarviikaevenáššivestnesgjemnessandnesagdenesrennesoyxn--avery-yuaxn--tysvr-vrabearalváhkikongsbergspydebergrandabergxn--andy-iradavvesiidaxn--krdsherad-m8aporsáŋgufredrikstadbjerkreimringeburennebuaurskog-holandnotteroyxn--vgsy-qoa0jxn--rmskog-byaskierváivelandbyglandfrolandaurlandforsandxn--bjddar-ptamidsundålesundalesundfetsundfarsundovre-eikerøvre-eikerakershusxn--moreke-juasørfoldøstfoldostfoldsorfoldhøyangerhoyangerlevangerorkangertanangerxn--vestvgy-ixa6olillesandulsteinxn--rennesy-v1agranvinskjervoyxn--klbu-woalavagisxn--h-2faxn--ryrvik-byakafjordkåfjordseljordfolkebiblxn--gjvik-wuajevnakerxn--kfjord-iuabudejjuxn--kranghke-b0axn--davvenjrga-y4axn--rland-uuaxn--ldingen-q1axn--mlselv-iuaxn--rady-iraxn--linds-prabrumunddalxn--ygarden-p1amo-i-ranaeidskogrømskogromskoghjelmelandxn--finny-yuaxn--sr-odal-q1axn--skjervy-v1aballangenkvanangenkvænangengratangenxn--hmmrfeasta-s4acvossevangensuohkanxn--rde-ulaxn--mli-tlaxn--ksnes-uuanordlandskanlandskånlandsortlandfuoiskuxn--rros-graxn--hcesuolo-7ya35bxn--eveni-0qa01gagaivuotnagáivuotnaxn--seral-lradrammenmodalenmosjoenjan-mayentorskensteigengloppenxn--snes-poamatta-varjjatxn--sr-fron-q1aomasvuotnajessheimbådåddjåxn--krager-gyaxn--kvfjord-nxaxn--asky-iraxn--snase-nraxn--bidr-5nacholtålenxn--vads-jraxn--jlster-byamosjøenxn--rst-0nastavernxn--ostery-fyaxn--oppegrd-ixaxn--sknit-yqaxn--risa-5naoppegårdskiptvetrendalenholtalenxn--mot-tlaxn--lhppi-xqaxn--holtlen-hxaxn--srreisa-q1akopervikxn--muost-0qaxn--bmlo-grahokksundkvalsundegersundxn--karmy-yuaullensakerxn--hylandet-54axn--kvitsy-fyaxn--bod-2nalangevågberlevågkristiansandxn--rsta-frahornindalstjørdalshalsenstjordalshalsensandnessjoenhámmárfeastaxn--lrdal-srasør-fronsor-fronnord-odalkristiansundmátta-várjjatvestvågøynesoddennotoddenbuskerudøygardenoygardensalangenlavangenralingenrælingenlodingenlødingenleaŋgaviikalaakesvuemieleangaviikauenorgexn--srfold-byaaskvollxn--rskog-uuaxn--nry-yla5gxn--vry-yla5ghammarfeastaxn--rhkkervju-01afxn--givuotna-8yakommunekrokstadelvanedre-eikerhagebostadhægebostadxn--berlevg-jxakviteseidxn--s-1faxn--l-1faxn--nmesjevuemie-tcbafuosskomoårekemoarekexn--lt-liacxn--jrpeland-54asvalbardoppegardholmestrandtvedestrandsogndalsokndalarendalsunndalfolldalxn--krjohka-hwab49jlyngdaletnedalnorddalsaltdalgausdalskedsmovaksdalgjesdalstordalxn--frya-hraaarbortedrangedalxn--smna-graaurskog-hølandxn--vg-yiabtjeldsundhaugesundlindesnesxn--mre-og-romsdal-qqbxn--dnna-gradyntmpheremerseineshacknetenterprisecloudmineaccomaorimāoriorgmilcriiwigennetschoolhealthkiwigovtgeekxn--mori-qsacloudnsparliamentcomedorgcompronetedugovmuseumwebsitekinservicebarsywebsitebuildereerobookheimdnsleapcelleero-stagetechcrscsslorigingohomecdbedeeeiemesecabgngilnlalplchfisiincnnoroptatitmtltruauhulumkdkukskjplvtrgrfrkrhrusesismycynzcznetinteduassoososcloudstgbetaaezaeuhkusjshatenadiarycdn77hoptozaptois-a-knightmyftpno-ipjpnddnssdpdnsspdnsbarsysweetpepperis-a-bruinsfanis-very-sweetservegameis-a-soxfanhomelinuxcdn77-secureservebbsmisconfusedwebredirectblogsitefreedesktopcouchpotatofriestoolforgeaccesscamis-lostreadmyblogsmall-webfedorapeopleserveftpis-a-celticsfanmywirepotagertwmailin-dslsellsyourhomeread-booksfreeddnscable-modemis-savednflfanufcfanmlbfanstuff-4-saleendoftheinternetin-vpnmy-firewallhomeftpis-localis-a-chefboldlygoingnowherewebhopselfipkicks-assroxatunkcamdvrfedoraprojectgotdnsdvrdnsdyndnspubtlspimientahomeunixdontexistfedorainfracloudwmflabsfspagesbmoattachmentsteckidsfamilydsdnsaliasdynaliasnow-dnscloudnsdoomdnsduckdnsblogdnshomednsroutingthecloudendofinternetdsmynasip-dynamicpoivronhttpbinmyfirewallis-very-evilmysecuritycamerais-a-linux-userwmcloudis-a-geektuxfamilyis-a-candidatedoesntexistis-very-badhobby-sitegame-hostaltervistais-foundis-a-patsfandnsdojohepforgepodzonedynservcollegefanis-very-goodfrom-meis-very-niceisa-geeknerdpolacmedsldingorgcomnomgobabonetedupleskaemhlxmyboxrockyprvcydeuxfleursvibekitprodpdnscodebergheyflowstatichostlinkyhostorgmilcomnomgobneteduorgcomeduiorgmilcomngonetedugovcloudns1337ngrokacorggogfamcomwebgobnetedugokgopgkpgovgosbizpasaugumicsopozpapuwmwsrprusiskwpspkppspkmpspokeoiawsawifoumsdnskokwpmuppuppsppiwwiwoowuzswkzoschrzpisdnwzmiuwwitdpssewsseumigugimoirmpinbwinbwiihupporzgwgriwupowwskrwioswuozstarostwokonsulattmpccopruszkowmyspreadshopostrodakartuzyopolegminamediaustkazgorajgoraolawailawalomzawloclradombytomjaworznotargilubinkoninzagantorunkutnokepnonakloczestsopotsanokturekplockslasksklepzarowlukowmedaidgdaorgmilrelcomnomatmgsmartneteduelkgovwawsossexbiztgorysejnytychypomorzeboleslawiechomesklepsdscloudunicloudzakopanelegnicarawa-mazbydgoszczswidnikkrasnikwloclawekbielawamragowograjeworealestatebeskidykaszubymalopolskaprzeworskswiebodzinlecznadfirmaszkolawarmiagdyniamiastakazimierz-dolnymalborkswidnicadlugolekaostrolekapodlasieelblagtravelsimplesitezachpomormielecszczecinnieruchomosciwalbrzychlezajsklublinbedzinpoznanwielunmielnooleckostarachowicedkontopowiatwroclawrybniksuwalkileborkslupskgdanskostrowwlkptarnobrzegtourismwegrowkrakowglogowyou2pilanysamailwrocinfoagroautobeepshoppriviqhslapypiszlodzcfolksecommerce-shopmazurypulawyskoczowrzeszowpomorskiezgierzkaliszolkuszlowiczostrowiecsosnowiecmazowszewodzislawbialowiezazgorzeleckatowicepabianicejelenia-gorawolominkarpaczsieradznowarudaczeladzkonskowolaskierniewiceswinoujscieturystykabieszczadycieszynketrzynolsztynbialystokbabia-goraprochowicewarszawastalowa-wolapolkowicegorlicegliwiceponiatowalimanowalubartowaugustowkobierzyceopocznognieznoszczytnokolobrzegshoparenapodhalebielskoklodzkostargardcoshipatwithplayitownnamecoorgnetedugovacorgcomproestnetedugovbiznameislaprofinforechtngrokmedaaaacacpaenglawjurbarbarsykeeneticavocatacctcloudnsorgcomsecplonetedugov123paginaweborgcomnetintedugovnomepublidkinbarsygovx443cloudnsorgmilcomnetedugovcooporgmilcomschnetedugovnamecomcannetlibassoaemclantmcontstoreorgcomnomrecwwwbarsyfirminfoshopartsstackitmyddnswebspacelima-cityacincooxorgedugovbarsybrendlyhbvpsvpsspectrumlandinghostingacppmordoviamcprecbgorgmilcomspbnetintedumsknovgovbirrasmcdirmytismircloudvladimirnalchikadygeyamarinepyatigorskmyjinobashkiriaeurodirvladikavkazna4ugroznykustanaikalmykiacldmaildagestaniranbuildcloudcanvaliaravalrwxwixdevelopmentappwritemigrationneedleverceldatabasestackitcodereplravendbsanityonporterlovableaccoorgmilnetgovcoopmedorgcompubschnetedugovservicemecomygovorggovtvmedorgcomnetedugovinfoedgfacbmlonihkutwpsryxzbdtmacfhppmyspreadshopbrandpartiorgcomfhvpress123minsidaitcouldbeworlanbibkommunalforbundfhskiopsyskomvuxkomforbnaturbruksgymnloginlineorgcomnetedugovenscaledeuusentsurgebotdaorgmilcomnetgovnowteleporthashbangplatformlovablebarsyshopwarebasehoplixbarsyonlinemsf5gitpagewawamscofigma-govcaffeinefigmacanvasoltstscwputerbarsysupportchatgptsquareomniweopensocialcpanelplaycodenotionnovecorewpsquaredpreviewjelecyonbyensrhtfastvpspieboxconvexjouwwebheyflowplatformshdocsflowyloginlinemadethissourcecraftclouderaorgorgcomartedugouvunivmeorgcomnetedugovsurveysstatichfheiyumanusxs4allprojectmyfastubervibehostapp-ionosdeployagentmecoorgcomschnetedugovbizcncostoreorgmilcomneteduembaixadaconsuladokiraranohoprincipesaotomeheliohobarsystorebaseshopwaresellfyaisanityabkhaziavologdamordoviapenzalenugsochinavoiexnetspbmsknovnorth-kazakhstanashgabadkareliaarmeniageorgiavladimirnalchikivanovobukharaadygeyakhakassiakalugakrasnodarjambylaktyubinsktroitskbryanskobninskkurganazerbaijanpokrovskbashkiriatselinogradvladikavkazmurmansktulatuvamangyshlaktashkentchimkentgroznykaragandatermezarkhangelskkustanaikalmykiabalashoveast-kazakhstankaracoldagestantogliattibarsyredorgcomgobedumirenaccoorgjelasticdiscoursecleverappsschacmiincogoornetonlineshopcogoorgmilcomwebnicnetintedugovbiznametestcoorgmilcomnomnetedugovorangecloudpersoindorgcomfinnatnetgovensmincomtourismintlinfox0611orgmilcomnetedugovquickconnectvpnplusnettprequalifymeaddrmyaddrntdllwadlnctvavdrk12orgmilpolbeltelcomwebgennetedutskkepgovbbsbiznameinfocoorgmilcompronetedugovbiznameinfobetter-thanworse-thansakurafromdyndnson-the-webmymailerorgmilurlcomneteduidvgovmydnsgameclubebizmeneacsccogotvorhotelmilmobiinfovodteiflgplkmsmsbcckhincndnvncoztltmkckppzpdprvcvkvlvcrkrkscxuzchernovtsyrivneyaltaodesavolynrovnolutskltdinforgcomnetedugovbizvinnicazhitomirternopilpoltavakropyvnytskyizaporizhzhiasevastopolsebastopoluzhgoroduzhhorodkharkovkharkivvinnytsiakhmelnytskyizaporizhzhecrimeaodessazhytomyrnikolaevcherkassydonetskluganskluhanskkirovogradivano-frankivskchernivtsikrymkievkyivlvivsumyzakarpattiamykolaivcherkasychernigovkhersonchernihivdnipropetrovskdnepropetrovskkhmelnitskiyneacsccogoorusorgmilcomedugovmyspreadshopadimono-ipbarsybarsyonlinelayershiftnh-servretrosnubapicampaignservicelugaffinitylotteryweeklylotteryraffleentrygluglugsmeaccoindependent-inquestnimsitecopropymntltdorgplcschnetgovnhsbarsyindependent-commissionindependent-reviewpolicepublic-inquiryindependent-panelconnhospindependent-inquiryroyal-commissionoraclegovcloudappscck12libaws-govccphxcclibpvtparochchtrcck12libcceatonk12coglibtecgendstmusann-arborwashtenawcck12glghcck12sealibforksolympiabainbridge-islkeyporthoquiamyarrow-pointcentraliaport-townsendsequimport-ludlowrentonsilverdalebremertonredmondsheltonbellevueport-orchardport-angeleskingstonchehalisaberdeengig-harborseattlepoulsboidmdndsddemenegacalamaiavawapailalflnmdcncscohnhmihiviwiriinmntnmocoutvtctmtgunjokakwvnvprarorasmskstxwynykyazisadninsnngosrvis-bymircloudservernamepointtoenscaledland-4-salefreeddnsstuff-4-saleazure-apinoipdatabricksappscloudnsgolffanheliohostazurewebsitesgvorgmilcomgubneteducoorgcomnetd0egvorgmilcomnetedugovmydnsiacostoree12orgmilcomnomwebgobbibrectecnetintedugovraremprendefirminfoartseducok12orgcomnethidnsadidacaionioapsonlahanamhanoicamauhueorgcompronetintedugovbizbacninhtayninhhoabinhnamdinhtravinhhaiphongvinhlonghaiduongquangnamquangtrithuathienhuequangninhbacgianghaugiangquangbinhsoctrangbentrethanhphohochiminhdanangkontumhatinhkhanhhoathanhhoahealthgialailaocaiyenbaibackanngheanlonganphuyenphuthocanthodaklakdongnainameinfovinhphucdongthapkiengiangtiengiangquangngailaichaulangsonlamdongdaknonghagiangangiangcaobangbinhduongninhthuanbinhthuanbaclieuthaibinhninhbinhbinhdinhtuyenquanghungyenbaria-vungtauthainguyendienbienbinhphuocschbizputerimagine-proxyorgcomnetedugovcloud66advisormypetsdyndnsxn--8dbq2axn--4dbgdty6cxn--5dbhl8dxn--hebda8bxn--80auxn--d1atxn--c1avgxn--o1acxn--o1achxn--90azhxn--55qx5dxn--uc0atvxn--od0algxn--wcvs22dxn--gmqw5axn--mxtq1mxn--12c1fe0brxn--h3cuzk1dixn--12co0c3b4evaxn--12cfi8ixb8lxn--o3cyx2axn--m3ch0j3axn--j1adpxn--90amcxn--90a1afxn--h1ahnxn--j1ael8bxn--h1alizxn--c1avgxn--j1aefxn--80aaa0cvacxn--41acaffeineexeopentunnelbotdashtelebitorgtmaccoagricorgmilnomwebnicngonetaltedugovlawnisschoolgrondaraccoorgmilcomschnetedugovbizinfoprg1-zeropstritonstackitlimazeropsaccoorgmilgovяспборгкоммскбизмирсамаракрымсочиакодпроргобрупрצהלממשלישובאקדמיהองค์กรธุรกิจรัฐบาลศึกษาทหารเน็ต教育網絡組織公司政府個人닷넷한국澳门新闻澳門联通家電嘉里招聘通販닷컴삼성コムგეбгрфеюadcdbdgdidmdsdtdaebedeeegeiejekemenepereseveyegabacalamanauavapaqasazacfbfafgfnfpfwftfbgcgagggegkgngmgsgpgvgtgugilmlnlalclglplsltlhmimjmkmmmomambmcmdmfmgmzmpmsmtmgbbblbsbecccacnclcmcvctcscmhkhghchbhthphshlinikifigiaibicivisikninhnmncnbngnsnpnvntnjoionomobocoaofodorosotoptstttytatbtetgtithtmtltrusuvuaucueuguhulumunufjdjbjtjsjlkmkhkfkdkcktkukskpkgpmpnpkpjpgqaqmqiqsvtvcvbvmvlvrwpwtwzwbwcwawgwkwmwtrsrprgrfrercrbrarnrmrlrkrirhrwsusrssspsgsesbsaslsmsissxmxaxcxuypysylymykygybycyuztzsznzmzkzdzczbzazελευ世界台灣购物公益点看臺灣网络書籍在线网站手机机构大拿游戏信息台湾谷歌慈善商标香港中国餐厅网址中國商城食品微博政务移动集团公司八卦商店健康网店政府时尚佛山中信娱乐广东企业homedepotengineeringاماراتrepublicankuokgroupversicherungchannelcitadelxn--pgbs0dhxn--b4w605ferdstatebankwebsitexn--mgb9awbf亚马逊淡马锡alibabaxn--ngbc5azdxn--mgbbh1axn--45br5cyltoshibabuildworldcloudtradeguideplacespacedancemoviephoneprimesmilebiblestyleappleazurestoreskypegripexn--l1accdrivelottehorsehouseleasechasereisestadahondaomegaaetnaamicaninjanokiamediadeltavodkaedekaosakapizzaslingemailgmailtirolshelltmallfinallegaltotalhotelamfamforumrehabmusicciticricohcoachwatchboschearthfaithirishmiamiarchidubaiguccipraxiみんなストアセールcanonsalononionnikonepsonkoelngreensevencrownikanoradioaudioweiboglobopromogalloyahoociscorodeovideomangobingotokyovolvolottokyotophotosmartsportquesttrusthyattjetztadultcymrubaidutushuxn--kprw13dubankclickblackmerckgroupsharpcheapnowtvxn--h2brj9cקוםհայоргсрбмонкомбелмкдқазрусукрمصرقطرعربكومdadcfdmedwedredphdthdbidpidkrdmsdltdiceonewmeglemoerwecfageacbanbambaaaammakianraspacpaaxawtfbcgaegongingaigvigorgdogdhlmilrilonlaolloluoljllcalgalnflafltelsrlfrllplkimibmcamcombommomifmabbjcbscbwebcabnabtabmlbpubabcbbcnecincpncllcstcwtcpwcnyckfhbzhovhmoiskiobisbitcifyituipinvinwinxincbnbcnmanfangdnmenrenkpnmtnyunrunfununobiojioriohbogmofooboooooacoecoceongoproartistottnttbbtcateatlatvetpetbetnethktmitfitintjothotgotdotbotprueduicujnjyouinknhktdkappsapgapmapdnptopgopllpjmpzipvipripesqtrvdtvitvdevmovgovhivnrwlawsewnewbmwwownowhowdvrftrmtrsfrbarcartvscrseusawsupsubssbsadsddsldssasbmsmlsxxxboxfoxgmxtjxsextaxbuyflydiysoyjoyskypaydaygayxyzanzbizwebersenerpokerlameractortatarsolarລາວคอมไทยtourslocusnexuslexusgiftsbeatsboatspartspressglassswissकॉमनेटtiresgivescodeshomesgamestunesshoescardswalesloansvegastoolsdealsautosparisファッションworkssucksrocksxeroxforexfedexpartylillymoneystudyrugbytoraytoday中文网xn--unup4y天主教飞利浦新加坡enterprises我爱你嘉里大酒店christmasxn--fct429kholdingsxn--8y0a063axn--mgbx4cd0ablifestyleabogadoallstatenetbankكاثوليكxn--s9brj9cxn--gk3at1ebestbuycharityxn--55qx5dmicrosoftpropertybasketballhomegoodscorsicajewelrygallerygrocerysurgerycountrybrusselsverisignferreroxn--czr694bhdfcbankcommbanksoftbankپاكستانپاکستانnextdirectالسعوديهالعليانxn--h2brj9c8cxn--80adxhksshikshaxn--mgbai9azgqp6jcuisinellabarclayscatholicxn--kpry57dcompanyxn--xhq521bblackfridayxn--mgba3a3ejtsandvikxn--d1acj3bacademydownloadمليسياxn--j1amhxn--w4r85el8fhu5dnraipirangaathletaxn--fhbeixn--mgbqly7cvafrzuerichxn--c2br7gஇலங்கைcontractorsxn--io0a7igraphicsinsurancetemasekxn--xkc2al3hye2amotorcyclesphotographydirectoryplumbingxn--vhquvclothingtrainingcleaningwilliamhilllightingxn--mgba3a4f16ashoppingcateringeducationokinawapicturesventuresproductionsxn--9et52uwalmartഭാരതംsupportrealestatecapitalonexn--nqv7fs00emaauspostfloristdentistxn--qxamgodaddybradescobargainsmitsubishikerryhotelsxn--9dbq2axn--3pxu8kimmobilienxn--fjq720axn--mgbtx2bholidaymckinseymadridbusinessbuildersxn--4gbrimмоскваالسعودیةcoffeedegreelacaixapartnersalsaceofficeabbvievoyageorangegeorgeonlinechromemobilekindlegoogleoraclecircleschulesecureinsurexn--mgba7c0bbn0aestatexn--mgbc0a9azcgcruisehangoutxn--vuq861bxn--42c2d9arexrothfirestoneuniversityxn--nnx388alifeinsuranceextraspaceонлайнvermögensberatersoftwarexn--fiqs8sxn--mgbab2bdxn--w4rs40ltiendaभारतम्africatoyotaotsukasakuracameracreditcardnagoyaconsultingnetworktheatermonsterprogressivepioneerxn--55qw42gracingdatingvotingvikinglivinggivingxn--bck1b9a5dre4cbrotherweatherjoburgفلسطينlplfinancialxn--clchc0ea0b2g2a9gcdfutbolschoolsocialglobaldentalwoodsidechanelairtelmatteltravelrealtorwebcamstreamభారత్unicomalstomxn--nodexn--6frz82gmuseumfurniturexn--rvc1e0am3exn--mix891faccenturexn--11b4c3dismailineustardiscountquebeccomsecclinicservicesxn--y9a3aqxn--c1avgswatchchurchsearchالاردنmarketingcontacthealthmonashshoujisanofitaipeiamericanexpresssuzukiアマゾンクラウドポイントbhartiグーグルxn--mgberp4a5d4armemorialxn--1qqw23alondonmormoninstitutevisionbostonnortoncouponmaisonamazonvirginberlindesigndurbanolayannissananquanxihuanhitachikaufengardenreisenbayerntechnologydatsunxn--90a3aclatinocasinostudiophysioxn--ngbe9e0apharmacytattootaobaoaramcoexpertreportabbottdirectselectimamatfairwindspictettargetmarketintuittravelersinsurancecreditdupontryukyusuppliesxn--tckwebnpparibasschmidtmerckmsdyodobashirestaurantbridgestonecricketxn--fpcrj9c3dbostikbroadwayattorneylefrakemerckxn--fiq228c5hscareersfarmerswinnersflowersxn--wgbh1cguitarsxn--54b7fta0ccxn--p1acfmakeupgalluplandroverxn--kcrx77d1x4agoldpointbauhausxn--mgbayh7gpahiphopplaystationxn--mgba3a4fraxn--eckvdtc9dhyundaixn--gckr3f0fistanbulticketsmarketsflightschintaireviewsxn--3e0b707ewindowsxn--fiqz9sfinancialxn--fzys8d69uvgmابوظبيdiscoverreviewবাংলাxn--5su34j936bgsgmoscowobserverapartmentsдетиارامكوсайтeurovisionxn--i1b6b1a6a2exn--xkc2dl3a5ee0hتونسموقعبارتڀارتشبكةعمانبيتكعراقreadkredbondlandbandfundfoodprodgoldfordtubecafesafelifeggeeieeefreefagepagegugezonewinememenamegamesaleablebikenikelikecarecbreherefiresaveloveliveblueartedatesitevotecaseluxebofamodaltdaasdatiaayogasinavanashiaasiajavabbvatevavivadatazaraarpacasavisasncfprofmaifsurfgolfdvagsongbingpingwangkpmggoogblogpohlfailcooldellcalldeallidlsarlfilmteamroomfarmimdbarabclubhdfcicbchsbcgmbhrichtechfishdishcashminiernikddiaudiwikimobitaxicitikiwidesiqponskinloanakdnwienopenporncerntownimmolimoolloinfonicofidolegosaxozeroaerovivoautovotomotofastbestresthostpostnextlgbtchatseatgiftmeetdietreitmintrentgentspotscotguruitausohumenucyoubanklinkpinkdclktalksilkbookseekworkrsvpaarpjeepshopcoophelpcamppccwshowbeerstarruhrflirweirhaircarsparsjprshausplusnewstipstoysjobskidsfanspicsdocsxboxamexsexynavycitysonyarmyallybabyplaydeliverybuzzgbizlamborghiniphilipsලංකාಭಾರತfitnessexpresslanxesspfizercenterwalterlawyersoccercareerkosherbrokerlockerdealerdoctorauthorxn--mgbqly7c0a67fbcvermögensberatungjaguarxn--pssy2uxn--hxt814eflickrrepairrogersairbusxn--mgbai9a5eva00beventsyachtsxn--t60b56aভাৰতভারতभारतभारोतviajeshermeshughesxn--j1aefसंगठनvillasଭାରତclaimshotelsભારતzapposphotosjuegoscondostatamotorsgratistennisਭਾਰਤtkmaxxtjmaxxschaeffleryandexxn--80aswgrealtysafetybeautyluxuryxn--3ds443gsupplyfamilyxn--o3cw4hhockeysydneyxn--90aenissayalipayenergycomputeragencyxn--rovu88b電訊盈科xn--gecrj9cstatefarmaccountantaquarelleolayangroup香格里拉xn--p1ai组织机构xn--1ck2e1bxn--mgbt3dhdschwarzموريتانياabudhabinowruzkomatsufujitsuhospitalxn--80asehdbxn--mgbtf8flxn--j6w193gxn--yfro4i67oprudentialxn--flw351ecruisescoursesrecipesxn--e1a4cferrarixn--ses554gxn--wgbl6awatchesstaplessinglesxn--mgbcpq6gpa1axn--otu796dpropertiescreditunionxn--mgbah1a3hjkrdstockholmhisamitsuالسعوديةstcgroupdomainsoriginscouponsbloombergclubmedfroganslimitedxn--80aqecdr1aexposedinternationalequipmentbarclaycardxn--q7ce6axn--mgbi4ecexpprotectionassociatesconstructionxn--cck2b3bxn--45q11candroidfoundationישראלxn--mgbca7dzdocliniqueboutiqueengineerxn--qxa6asystemsfirmdalefashionauctionxn--nqv7finfinitirentalsreliancetradingweddingfishinghostinggentingbookingcookingxn--3hcrj9cgraingerxn--czrs0tdemocratsamsungyokohamaxn--h2breg3evexn--nyqy26alundbeckmelbournevacationssolutionsfrontierxn--vermgensberatung-pwbmanagementxn--cg4bkixn--mgb2ddeslincolnhamburgsandvikcoromantblockbusterairforcebarefootxn--4dbrk0ceinvestmentsfeedbackcommunityxn--ngbrxالبحرينdiamondsamsterdamhealthcareredumbrellaxn--mxtq1mxn--2scrj9cagakhanxn--mgbpl2fhкатоликcaravanசிங்கப்பூர்richardlimortgageamericanfamilyxn--fzc2c9e2cscholarshipssaarlandxn--imr513nvlaanderensamsclubgoodyearkitchenஇந்தியாweatherchannelallfinanzxn--kput3iالسعودیۃxn--90aisxn--efvy88hالجزائرxn--mgbaam7a8hexchangejpmorganxn--tiq49xqyjfidelitysecurityxn--mk1bu44cwanggouxn--fiq64bxn--6qq986b3xlxn--mgbbh1a71exn--80ao21amarshallsxn--5tzm5gtravelerspanasoniclatrobeyoutubeaccountantsxn--rhqv96gxn--cckwcxetdanalyticsxn--ygbi2ammxبازاربھارتسوريةorganicfreseniusسورياxn--9krt00axn--qcka1pmcxn--jlq480n2rgdeloittesciencefinancexn--jvr189mxn--30rr7yhomesensehotmailbaseballfootballleclercboehringerxn--q9jyb4cxn--mix082fاليمنهمراهpolitieسودانايرانایرانnetflixyamaxunxn--lgbbat1ad8jcollegestoragecapetowncolognekerrypropertiesxn--mgbgu82axn--ogbpf8flxn--czru2dwhoswhociprianilasallexn--g2xx48cforsalebanamexaudiblexn--vermgensberater-ctbxn--zfr164bericssonvanguardxn--45brj9cindustriestheatremarriottxn--3bst00mcomparexn--mgberp4a5d4a87gcapitaldigitalالمغربbarcelonashangrilaxn--d1alfcalvinkleinwwwcitysapporokawasakinagoyasendaikobekitakyushuyokohamackjp";
  var rulesRoot = 658;
  var exceptionsRoot = 662;

  // node_modules/tldts/dist/es6/src/suffix-trie.js
  var numberOfNodes = nodeFlags.length;
  var numberOfEdges = edgeLength.length;
  var edgeOffset = new Uint32Array(numberOfEdges);
  var edgeHash = new Uint32Array(numberOfEdges);
  var wildcardEdge = new Int32Array(numberOfNodes).fill(-1);
  for (let node = 0, offset = 0; node < numberOfNodes; node += 1) {
    for (let edge = edgeStart[node]; edge < edgeStart[node + 1]; edge += 1) {
      edgeOffset[edge] = offset;
      const end = offset + edgeLength[edge];
      let hash = 5381;
      for (let i = end - 1; i >= offset; i -= 1) {
        hash = hash * 33 ^ labelText.charCodeAt(i);
      }
      edgeHash[edge] = hash >>> 0;
      if (edgeLength[edge] === 1 && labelText.charCodeAt(offset) === 42) {
        wildcardEdge[node] = edge;
      }
      offset = end;
    }
  }
  var matchNode = -1;
  var matchStart = 0;
  var matchEnd = 0;
  function labelEquals(edge, hostname, start, length) {
    if (edgeLength[edge] !== length) {
      return false;
    }
    const offset = edgeOffset[edge];
    for (let i = 0; i < length; i += 1) {
      if (labelText.charCodeAt(offset + i) !== hostname.charCodeAt(start + i)) {
        return false;
      }
    }
    return true;
  }
  function findEdge(node, hash, hostname, start, length) {
    let lo = edgeStart[node];
    let hi = edgeStart[node + 1];
    while (lo < hi) {
      const mid = lo + hi >>> 1;
      const value = edgeHash[mid];
      if (value < hash) {
        lo = mid + 1;
      } else if (value > hash) {
        hi = mid;
      } else {
        for (let e = mid; e >= lo && edgeHash[e] === hash; e -= 1) {
          if (labelEquals(e, hostname, start, length))
            return e;
        }
        for (let e = mid + 1; e < hi && edgeHash[e] === hash; e += 1) {
          if (labelEquals(e, hostname, start, length))
            return e;
        }
        return -1;
      }
    }
    return -1;
  }
  function walk(hostname, root, allowedMask) {
    let node = root;
    let end = hostname.length;
    let hash = 5381;
    matchNode = -1;
    for (let i = hostname.length - 1; i >= 0; i -= 1) {
      const code = hostname.charCodeAt(i);
      if (code === 46) {
        const start = i + 1;
        let edge2 = findEdge(node, hash >>> 0, hostname, start, end - start);
        if (edge2 === -1 && end !== start) {
          edge2 = wildcardEdge[node];
        }
        if (edge2 === -1) {
          return matchNode !== -1;
        }
        node = edgeChild[edge2];
        if ((nodeFlags[node] & allowedMask) !== 0) {
          matchNode = node;
          matchStart = start;
          matchEnd = end;
        }
        end = i;
        hash = 5381;
      } else {
        hash = hash * 33 ^ code;
      }
    }
    let edge = findEdge(node, hash >>> 0, hostname, 0, end);
    if (edge === -1 && end !== 0) {
      edge = wildcardEdge[node];
    }
    if (edge !== -1) {
      node = edgeChild[edge];
      if ((nodeFlags[node] & allowedMask) !== 0) {
        matchNode = node;
        matchStart = 0;
        matchEnd = end;
      }
    }
    return matchNode !== -1;
  }
  function suffixLookup(hostname, options, out) {
    if (fast_path_default(hostname, options, out)) {
      return false;
    }
    const allowedMask = (options.allowPrivateDomains ? 2 : 0) | (options.allowIcannDomains ? 1 : 0);
    if (walk(hostname, exceptionsRoot, allowedMask)) {
      out.isIcann = (nodeFlags[matchNode] & 1) !== 0;
      out.isPrivate = (nodeFlags[matchNode] & 2) !== 0;
      out.publicSuffix = hostname.slice(matchEnd + 1);
      return true;
    }
    if (walk(hostname, rulesRoot, allowedMask)) {
      out.isIcann = (nodeFlags[matchNode] & 1) !== 0;
      out.isPrivate = (nodeFlags[matchNode] & 2) !== 0;
      out.publicSuffix = hostname.slice(matchStart);
      return false;
    }
    out.isIcann = false;
    out.isPrivate = false;
    const lastDot = hostname.lastIndexOf(".");
    out.publicSuffix = lastDot === -1 ? hostname : hostname.slice(lastDot + 1);
    return false;
  }

  // node_modules/tldts/dist/es6/index.js
  var RESULT = getEmptyResult();
  function parse(url, options) {
    return parseImpl(url, 5, suffixLookup, options, getEmptyResult());
  }
  function getDomain2(url, options) {
    resetResult(RESULT);
    return parseImpl(url, 3, suffixLookup, options, RESULT).domain;
  }

  // userscript/src/service.ts
  var MAX_SERVICE_LENGTH = 100;
  function normalizeService(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().toLowerCase().replace(/\.+$/, "");
    if (!trimmed) return null;
    if (trimmed.length > MAX_SERVICE_LENGTH) return null;
    if (/[\s\u0000-\u001f\u007f/?#]/.test(trimmed)) return null;
    return trimmed;
  }
  function registrableDomain(host) {
    const cleaned = String(host ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (!cleaned) return null;
    if (parse(cleaned).isIp) return null;
    return getDomain2(cleaned, { allowPrivateDomains: true }) ?? null;
  }
  function normalizedMappings(mappings) {
    const normalized = /* @__PURE__ */ new Map();
    for (const [key, value] of Object.entries(mappings ?? {})) {
      const normalizedKey = normalizeService(key);
      if (!normalizedKey || normalized.has(normalizedKey)) continue;
      const normalizedValue = normalizeService(value);
      if (normalizedValue) normalized.set(normalizedKey, normalizedValue);
    }
    return normalized;
  }
  function resolveService(rawUrl, options = {}) {
    let url;
    try {
      url = new URL(String(rawUrl ?? ""));
    } catch {
      return { ok: false, reason: "not-http", host: null };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reason: "not-http", host: null };
    }
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (!host) return { ok: false, reason: "not-http", host: null };
    const domain = registrableDomain(host);
    const override = normalizeService(options.override ?? "");
    if (override) return { ok: true, service: override, host, source: "manual" };
    const mappings = normalizedMappings(options.mappings);
    const mapped = mappings.get(host) ?? (domain ? mappings.get(domain) : void 0);
    if (mapped) return { ok: true, service: mapped, host, source: "mapping" };
    if (domain) return { ok: true, service: domain, host, source: "public-suffix" };
    return { ok: false, reason: "unresolvable", host };
  }

  // userscript/src/gm.ts
  var RequestAbortedError = class extends Error {
    name = "RequestAbortedError";
  };
  var RequestTimeoutError = class extends Error {
    name = "RequestTimeoutError";
  };
  function toHeaderMap(raw) {
    const headers = {};
    for (const line of (raw ?? "").split(/[\r\n]+/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return headers;
  }
  function createGmTransport(gm) {
    return (request) => new Promise((resolve, reject) => {
      if (!gm.xmlhttpRequest) {
        reject(new TypeError("GM_xmlhttpRequest is not available"));
        return;
      }
      let settled = false;
      const detach = () => request.signal?.removeEventListener("abort", abort);
      const finish = (action2) => {
        if (settled) return;
        settled = true;
        detach();
        action2();
      };
      const handle = gm.xmlhttpRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        data: request.body,
        timeout: request.timeoutMs,
        redirect: "error",
        onload: (response) => finish(() => resolve({
          status: response.status,
          responseText: response.responseText ?? "",
          headers: toHeaderMap(response.responseHeaders),
          ...response.finalUrl ? { finalUrl: response.finalUrl } : {}
        })),
        onerror: (response) => finish(() => reject(new TypeError(response?.error ?? "network error"))),
        ontimeout: () => finish(() => reject(new RequestTimeoutError("request timed out"))),
        onabort: () => finish(() => reject(new RequestAbortedError("request aborted")))
      });
      function abort() {
        try {
          handle.abort?.();
        } catch {
        }
      }
      if (request.signal) {
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
  async function settle(value) {
    return await value;
  }
  function createGmKeyValueStore(gm) {
    return {
      async get(key, fallback) {
        if (!gm.getValue) return fallback;
        const value = await settle(gm.getValue(key, fallback));
        return value === void 0 ? fallback : value;
      },
      async set(key, value) {
        await gm.setValue?.(key, value);
      },
      async remove(key) {
        await gm.deleteValue?.(key);
      }
    };
  }
  function detectGm() {
    const scope = globalThis;
    const gm = scope.GM;
    if (gm?.xmlhttpRequest) return gm;
    const xhr = scope.GM_xmlhttpRequest;
    if (!xhr) return null;
    return {
      xmlhttpRequest: xhr,
      getValue: scope.GM_getValue,
      setValue: scope.GM_setValue,
      deleteValue: scope.GM_deleteValue,
      getTab: scope.GM_getTab,
      saveTab: scope.GM_saveTab,
      registerMenuCommand: scope.GM_registerMenuCommand
    };
  }
  function readTabState(gm, timeoutMs = 400) {
    const getTab = gm.getTab;
    if (!getTab) return Promise.resolve({});
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value && typeof value === "object" ? { ...value } : {});
      };
      try {
        getTab((state) => finish(state));
      } catch {
        finish({});
      }
      setTimeout(() => finish({}), timeoutMs);
    });
  }
  async function writeTabState(gm, state) {
    const saveTab = gm.saveTab;
    if (!saveTab) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        saveTab(state, finish);
      } catch {
        finish();
      }
      setTimeout(finish, 200);
    });
  }

  // userscript/src/api.ts
  var MAX_EXCLUDE_IDS = 20;
  var MAX_EXCLUDE_UNIT = 2048;
  var MAX_EXCLUDE_BYTES = 8192;
  var MAX_CODE_WAIT_SECONDS = 120;
  var ApiError = class extends Error {
    constructor(kind, message, status, retryAfter, code) {
      super(message);
      this.kind = kind;
      this.status = status;
      this.retryAfter = retryAfter;
      this.code = code;
    }
    kind;
    status;
    retryAfter;
    code;
    name = "ApiError";
  };
  var BASE_URL_MESSAGES = {
    empty: "url.empty",
    invalid: "url.invalid",
    scheme: "url.scheme",
    credentials: "url.credentials",
    query: "url.query",
    hash: "url.hash"
  };
  function normalizeBaseUrl(input) {
    const raw = String(input ?? "").trim();
    if (!raw) return { ok: false, reason: "empty", message: t(BASE_URL_MESSAGES.empty) };
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      return { ok: false, reason: "invalid", message: t(BASE_URL_MESSAGES.invalid) };
    }
    const fail = (reason) => ({ ok: false, reason, message: t(BASE_URL_MESSAGES[reason]) });
    if (url.protocol !== "http:" && url.protocol !== "https:") return fail("scheme");
    if (url.username || url.password) return fail("credentials");
    if (url.search) return fail("query");
    if (url.hash) return fail("hash");
    const path = url.pathname.replace(/\/+$/, "");
    return { ok: true, baseUrl: `${url.origin}${path}`, insecure: url.protocol === "http:" && !isLoopbackHost(url.hostname) };
  }
  function isLoopbackHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  }
  var DEFAULT_TIMEOUT_MS = 2e4;
  function headerValue(headers, name) {
    if (!headers) return void 0;
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return value;
    }
    return void 0;
  }
  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }
  function isExclusionWithinLimits(exclude) {
    if (exclude.length > MAX_EXCLUDE_IDS) return false;
    let bytes = 0;
    for (const value of exclude) {
      if (value.length > MAX_EXCLUDE_UNIT) return false;
      bytes += new TextEncoder().encode(value).length;
    }
    return bytes <= MAX_EXCLUDE_BYTES;
  }
  function statusToKind(status) {
    if (status >= 200 && status < 300) return null;
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 404) return "not-found";
    if (status === 429) return "quota";
    if (status >= 500) return "upstream";
    if (status >= 400) return "invalid";
    return "protocol";
  }
  function createApiClient(options) {
    const base2 = options.baseUrl.replace(/\/+$/, "");
    const baseOrigin = new URL(base2).origin;
    function endpoint(path, query = []) {
      const url = new URL(`${base2}${path}`);
      if (url.origin !== baseOrigin) throw new ApiError("protocol", "请求地址越过了配置的 Mail Hub");
      for (const [key, value] of query) url.searchParams.append(key, value);
      return url.toString();
    }
    async function request(method, url, body, timeoutMs) {
      const request2 = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
          ...body === void 0 ? {} : { "Content-Type": "application/json" }
        },
        timeoutMs,
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      };
      let response;
      try {
        response = await options.send(request2);
      } catch (error) {
        if (error instanceof Error && error.name === "RequestAbortedError") {
          throw new ApiError("aborted", "请求已取消");
        }
        if (error instanceof Error && error.name === "RequestTimeoutError") {
          throw new ApiError("timeout", "请求超时");
        }
        throw new ApiError("network", error instanceof Error ? error.message : "网络请求失败");
      }
      if (response.finalUrl) {
        let finalOrigin = null;
        try {
          finalOrigin = new URL(response.finalUrl).origin;
        } catch {
          finalOrigin = null;
        }
        if (finalOrigin !== baseOrigin) {
          throw new ApiError("protocol", "响应来自配置以外的地址，已丢弃");
        }
      }
      const kind = statusToKind(response.status);
      let payload = null;
      if (response.responseText) {
        try {
          payload = JSON.parse(response.responseText);
        } catch {
          if (!kind) throw new ApiError("protocol", "响应不是 JSON", response.status);
        }
      }
      if (kind) {
        const record = asRecord(payload);
        const message = typeof record?.error === "string" ? record.error : `HTTP ${response.status}`;
        const retryAfter = kind === "quota" ? headerValue(response.headers, "retry-after") ?? (typeof record?.retryAfter === "string" ? record.retryAfter : null) : void 0;
        throw new ApiError(kind, message, response.status, retryAfter);
      }
      return { status: response.status, payload, headers: response.headers };
    }
    return {
      async listProviders() {
        const { payload } = await request("GET", endpoint("/api/providers"), void 0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const providers = asRecord(payload)?.providers;
        if (!Array.isArray(providers)) throw new ApiError("protocol", "提供商列表格式不符合预期");
        return providers.flatMap((entry) => {
          const record = asRecord(entry);
          if (!record || typeof record.name !== "string") return [];
          const features = asRecord(record.features);
          const rate = asRecord(record.rateStatus);
          return [{
            name: record.name,
            displayName: typeof record.displayName === "string" ? record.displayName : record.name,
            enabled: record.enabled !== false,
            autoDispatch: record.autoDispatch !== false,
            tier: record.tier === "paid" ? "paid" : "free",
            features: { pollInbox: features?.pollInbox === true },
            rateStatus: {
              available: rate?.available !== false,
              nextAvailableAt: typeof rate?.nextAvailableAt === "string" ? rate.nextAvailableAt : null,
              cooldownReason: typeof rate?.cooldownReason === "string" ? rate.cooldownReason : null
            }
          }];
        });
      },
      async createInbox(input) {
        const service = normalizeService(input.service);
        if (!service) throw new ApiError("invalid", t("err.badService"));
        const body = { for: service, needPolling: true };
        if (input.provider) body.provider = input.provider;
        const { payload } = await request(
          "POST",
          endpoint("/api/inbox"),
          body,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const record = asRecord(payload);
        if (!record || typeof record.id !== "string" || typeof record.address !== "string" || typeof record.provider !== "string") {
          throw new ApiError("protocol", "创建结果格式不符合预期");
        }
        return {
          id: record.id,
          address: record.address,
          provider: record.provider,
          expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
          features: asRecord(record.features) ?? {}
        };
      },
      async getInbox(id) {
        const { payload } = await request(
          "GET",
          endpoint(`/api/inbox/${encodeURIComponent(id)}`),
          void 0,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const record = asRecord(payload);
        if (!record || typeof record.id !== "string" || typeof record.address !== "string") {
          throw new ApiError("protocol", "邮箱状态格式不符合预期");
        }
        return {
          id: record.id,
          address: record.address,
          provider: typeof record.provider === "string" ? record.provider : "",
          service: typeof record.target_service === "string" ? record.target_service : null,
          status: typeof record.status === "string" ? record.status : "unknown",
          expiresAt: typeof record.expires_at === "string" ? record.expires_at : null
        };
      },
      async findInboxes(service) {
        const { payload } = await request("GET", endpoint("/api/inboxes", [
          ["for", service],
          ["status", "active"]
        ]), void 0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const rows = asRecord(payload)?.inboxes;
        if (!Array.isArray(rows)) throw new ApiError("protocol", "邮箱列表格式不符合预期");
        return rows.flatMap((entry) => {
          const record = asRecord(entry);
          if (!record || typeof record.id !== "string" || typeof record.address !== "string") return [];
          return [{
            id: record.id,
            address: record.address,
            provider: typeof record.provider === "string" ? record.provider : "",
            service: typeof record.target_service === "string" ? record.target_service : null,
            createdAt: typeof record.created_at === "string" ? record.created_at : null,
            expiresAt: typeof record.expires_at === "string" ? record.expires_at : null,
            status: typeof record.status === "string" ? record.status : "unknown"
          }];
        });
      },
      async waitForCode(input) {
        if (!isExclusionWithinLimits(input.exclude)) {
          throw new ApiError("invalid", t("err.seenFull"), void 0, null, "exclusions-full");
        }
        const timeout = Math.min(MAX_CODE_WAIT_SECONDS, Math.max(1, Math.trunc(input.timeoutSeconds) || 1));
        const query = [
          ["wait", "true"],
          ["timeout", String(timeout)],
          ...input.exclude.map((id) => ["excludeMessageId", id])
        ];
        const { payload } = await request(
          "GET",
          endpoint(`/api/inbox/${encodeURIComponent(input.inboxId)}/code`, query),
          void 0,
          timeout * 1e3 + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        );
        const record = asRecord(payload);
        if (!record) throw new ApiError("protocol", "收件结果格式不符合预期");
        const codes = Array.isArray(record.codes) ? record.codes.flatMap((entry) => {
          const code = asRecord(entry);
          if (!code || typeof code.value !== "string") return [];
          const type = code.type === "numeric" || code.type === "alphanumeric" || code.type === "link" ? code.type : "alphanumeric";
          return [{
            type,
            value: code.value,
            confidence: typeof code.confidence === "number" ? code.confidence : void 0,
            context: typeof code.context === "string" ? code.context : void 0
          }];
        }) : [];
        const email = asRecord(record.email);
        return {
          codes,
          email: email ? {
            from: typeof email.from === "string" ? email.from : void 0,
            subject: typeof email.subject === "string" ? email.subject : void 0,
            recipientAddress: typeof email.recipientAddress === "string" ? email.recipientAddress : null
          } : null,
          messageId: typeof record.messageId === "string" ? record.messageId : null,
          receivedAt: typeof record.receivedAt === "string" ? record.receivedAt : null
        };
      },
      async listMessages(inboxId) {
        const { payload } = await request(
          "GET",
          endpoint(`/api/inbox/${encodeURIComponent(inboxId)}/messages`),
          void 0,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const rows = asRecord(payload)?.messages;
        if (!Array.isArray(rows)) throw new ApiError("protocol", "邮件列表格式不符合预期");
        return rows.flatMap((entry) => {
          const record = asRecord(entry);
          if (!record || typeof record.id !== "string") return [];
          return [{
            id: record.id,
            from: typeof record.from === "string" ? record.from : "",
            subject: typeof record.subject === "string" ? record.subject : "",
            excerpt: typeof record.excerpt === "string" ? record.excerpt : "",
            receivedAt: typeof record.receivedAt === "string" ? record.receivedAt : ""
          }];
        });
      },
      async getMessage(inboxId, messageId) {
        const { payload } = await request(
          "GET",
          endpoint(`/api/inbox/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`),
          void 0,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const record = asRecord(payload);
        if (!record || typeof record.id !== "string") throw new ApiError("protocol", "邮件内容格式不符合预期");
        return {
          id: record.id,
          from: typeof record.from === "string" ? record.from : "",
          subject: typeof record.subject === "string" ? record.subject : "",
          excerpt: typeof record.excerpt === "string" ? record.excerpt : "",
          receivedAt: typeof record.receivedAt === "string" ? record.receivedAt : "",
          text: typeof record.text === "string" ? record.text : null,
          html: typeof record.html === "string" ? record.html : null
        };
      },
      async reportSuccess(inboxId, service) {
        const normalized = normalizeService(service);
        if (!normalized) throw new ApiError("invalid", t("err.badService"));
        const { payload } = await request(
          "POST",
          endpoint(`/api/inbox/${encodeURIComponent(inboxId)}/report`),
          { success: true, service: normalized },
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const record = asRecord(payload);
        return { ok: record?.ok !== false, action: typeof record?.action === "string" ? record.action : void 0 };
      },
      async closeInbox(inboxId) {
        const { payload } = await request(
          "DELETE",
          endpoint(`/api/inbox/${encodeURIComponent(inboxId)}`),
          void 0,
          options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        );
        const record = asRecord(payload);
        return { ok: record?.ok !== false };
      }
    };
  }

  // userscript/src/fill.ts
  var EMAIL_WORDS = /e-?mail|邮箱|郵箱|电子邮件|電子郵件|メール|이메일|correo/;
  var ACCOUNT_WORDS = /user(name)?|login|account|identifier|账号|帐号|用户名/;
  var CODE_WORDS = /code|otp|one.?time|verif|token|pin\b|passcode|验证码|校验码|驗證碼|動態|确认码|認証|인증/;
  var NOT_CODE_WORDS = /promo|coupon|invite|referr|zip|postal|邀请|优惠|邮编|phone|tel|mobile|手机/;
  var TEXTUAL = /* @__PURE__ */ new Set(["", "text", "email", "tel", "number", "search", "url"]);
  function scoreField(kind, field) {
    if (!TEXTUAL.has(field.type)) return 0;
    let score = 0;
    if (kind === "email") {
      if (field.type === "email") score += 10;
      if (field.autocomplete.includes("email")) score += 10;
      if (EMAIL_WORDS.test(field.text)) score += 7;
      if (field.autocomplete.includes("username") || ACCOUNT_WORDS.test(field.text)) score += 3;
      if (field.autocomplete.includes("one-time-code") || CODE_WORDS.test(field.text)) score -= 8;
      if (field.type === "tel" || field.type === "number") score -= 6;
    } else {
      if (field.autocomplete.includes("one-time-code")) score += 12;
      if (CODE_WORDS.test(field.text)) score += 7;
      if (NOT_CODE_WORDS.test(field.text)) score -= 8;
      if (field.inputMode === "numeric" || field.type === "number" || field.type === "tel") score += 2;
      if (field.maxLength >= 4 && field.maxLength <= 10) score += 3;
      if (field.splitRow) score += 8;
      const aboutEmail = field.type === "email" || field.autocomplete.includes("email") || EMAIL_WORDS.test(field.text) && !CODE_WORDS.test(field.text);
      if (aboutEmail) score -= 10;
    }
    if (score <= 0) return 0;
    if (field.recent) score += 3;
    if (!field.hasValue) score += 1;
    return score;
  }
  var MIN_SCORE = 6;
  function pickField(kind, fields) {
    let best = -1;
    let bestScore = MIN_SCORE - 1;
    fields.forEach((field, index) => {
      const score = scoreField(kind, field);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    return best;
  }
  var lastFocused = null;
  var lastFocusedAt = 0;
  function trackPageFocus(ownHost) {
    const onFocus = (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (ownHost.contains(target) || target.getRootNode() === ownHost.shadowRoot) return;
      lastFocused = new WeakRef(target);
      lastFocusedAt = Date.now();
    };
    document.addEventListener("focusin", onFocus, true);
    return () => document.removeEventListener("focusin", onFocus, true);
  }
  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  }
  function labelText2(input) {
    const parts = [];
    for (const label of Array.from(input.labels ?? [])) parts.push(label.textContent ?? "");
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) parts.push(input.ownerDocument.getElementById(id)?.textContent ?? "");
    }
    if (!parts.join("").trim()) {
      const previous = input.previousElementSibling;
      if (previous && previous.textContent && previous.textContent.length < 60) parts.push(previous.textContent);
    }
    return parts.join(" ");
  }
  function collect(root, out, depth = 0) {
    for (const element of Array.from(root.querySelectorAll("input, textarea"))) out.push(element);
    if (depth > 3) return;
    for (const host of Array.from(root.querySelectorAll("*"))) {
      if (host.shadowRoot && !host.hasAttribute("data-mailhub-assistant")) collect(host.shadowRoot, out, depth + 1);
    }
  }
  function inSplitRow(input, pool) {
    return splitGroup(input, pool) !== null;
  }
  function describe(input, recent, pool) {
    const text = [
      input.name,
      input.id,
      input.getAttribute("placeholder"),
      input.getAttribute("aria-label"),
      input.getAttribute("data-testid"),
      labelText2(input)
    ].filter(Boolean).join(" ").toLowerCase();
    return {
      type: input instanceof HTMLTextAreaElement ? "text" : (input.getAttribute("type") ?? "").toLowerCase(),
      autocomplete: (input.getAttribute("autocomplete") ?? "").toLowerCase(),
      text,
      inputMode: (input.getAttribute("inputmode") ?? "").toLowerCase(),
      maxLength: input.maxLength ?? -1,
      hasValue: Boolean(input.value),
      recent: input === recent,
      splitRow: inSplitRow(input, pool)
    };
  }
  function candidates() {
    const all = [];
    collect(document, all);
    return all.filter((input) => !input.disabled && !input.readOnly && isVisible(input) && !input.closest("[data-mailhub-assistant]"));
  }
  function splitGroup(field, pool) {
    if (!(field instanceof HTMLInputElement) || field.maxLength !== 1) return null;
    for (let ancestor = field.parentElement, level = 0; ancestor && level < 3; ancestor = ancestor.parentElement, level++) {
      const row = pool.filter((input) => input instanceof HTMLInputElement && input.maxLength === 1 && ancestor.contains(input));
      if (row.length >= 4) return row;
    }
    return null;
  }
  function writeValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    input.focus({ preventScroll: true });
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fillPage(kind, value) {
    const pool = candidates();
    const recentRef = lastFocused?.deref() ?? null;
    const recent = recentRef && Date.now() - lastFocusedAt < 12e4 ? recentRef : null;
    const index = pickField(kind, pool.map((input) => describe(input, recent, pool)));
    if (index < 0) return { ok: false, target: null };
    const field = pool[index];
    const group = kind === "code" ? splitGroup(field, pool) : null;
    if (group && group.length >= value.length) {
      Array.from(value).forEach((char, position) => writeValue(group[position], char));
      group[Math.min(value.length, group.length) - 1].blur();
      return { ok: true, target: group[0].parentElement ?? group[0] };
    }
    if (field.getBoundingClientRect().top < 0 || field.getBoundingClientRect().bottom > window.innerHeight) {
      field.scrollIntoView({ block: "center" });
    }
    writeValue(field, value);
    return { ok: true, target: field };
  }

  // userscript/src/panel.css
  var panel_default = "/* Tokens are the admin console's (src/public/css/tokens.css), so the assistant reads as the\n   same product. light-dark() follows :host's color-scheme, which the theme\n   setting pins. */\n:host {\n  --bg: light-dark(oklch(.975 .002 260), oklch(.17 .005 260));\n  --bg2: light-dark(oklch(1 0 0), oklch(.205 .005 260));\n  --bg3: light-dark(oklch(.955 .003 260), oklch(.25 .005 260));\n  --border: light-dark(oklch(.905 .004 260), oklch(.29 .006 260));\n  --border2: light-dark(oklch(.82 .005 260), oklch(.35 .006 260));\n  --text: light-dark(oklch(.21 .008 260), oklch(.95 .004 260));\n  --text2: light-dark(oklch(.47 .01 260), oklch(.75 .008 260));\n  --text3: light-dark(oklch(.54 .01 260), oklch(.6 .01 260));\n  --emerald: light-dark(#0d7f64, #34d399);\n  --emerald-hover: light-dark(#086d57, #2bc48a);\n  --amber: light-dark(#9a5b18, #fbbf24);\n  --rose: light-dark(#b4234f, #fb7185);\n  --on-accent: light-dark(#fff, oklch(.17 .005 260));\n  --shadow: 0 10px 28px light-dark(oklch(.2 .01 260 / .16), oklch(0 0 0 / .55)), 0 1px 3px light-dark(oklch(.2 .01 260 / .08), oklch(0 0 0 / .3));\n  --focus-ring: 0 0 0 3px color-mix(in oklab, var(--emerald) 35%, transparent);\n  --radius: 10px;\n  --radius-sm: 7px;\n  --spring: linear(0, 0.07, 0.208, 0.362, 0.501, 0.618, 0.715, 0.788, 0.846, 0.887, 0.918, 0.942, 0.958, 0.97, 0.979, 0.985, 0.989, 0.992, 0.995, 0.996, 1);\n  --spring-ms: 374ms;\n  --ease-out: cubic-bezier(.23, 1, .32, 1);\n  --sans: 'Outfit', 'Noto Sans SC', system-ui, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif;\n  --mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, 'SFMono-Regular', Menlo, monospace;\n\n  all: initial;\n  position: fixed;\n  z-index: 2147483000;\n  top: 16px;\n  left: auto;\n  color: var(--text);\n  font: 400 14px/1.5 var(--sans);\n  font-variant-numeric: tabular-nums;\n  -webkit-font-smoothing: antialiased;\n  text-align: left;\n  letter-spacing: normal;\n}\n:host([data-theme='light']) { color-scheme: light; }\n:host([data-theme='dark']) { color-scheme: dark; }\n\n*, *::before, *::after { box-sizing: border-box; }\n[hidden] { display: none !important; }\n::selection { background: color-mix(in oklab, var(--emerald) 28%, transparent); color: var(--text); }\np { margin: 0; }\nul { margin: 0; padding: 0; list-style: none; }\n.ico { flex: none; display: block; }\n\nbutton, select, input { font: inherit; color: inherit; margin: 0; }\nbutton { cursor: pointer; background: none; border: 0; padding: 0; }\nbutton:focus-visible, .value:focus-visible { outline: 2px solid var(--emerald); outline-offset: 2px; border-radius: var(--radius-sm); }\n\n/* ---------------------------------------------------------------- shell */\n.shell {\n  /* Narrowed in placeShell when the visible area is smaller (100vw counts the scrollbar). */\n  width: 388px;\n  display: flex;\n  flex-direction: column;\n  position: relative;\n}\n\n.capsule {\n  height: 60px;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 0 8px 0 10px;\n  background: var(--bg2);\n  border: 1px solid var(--border);\n  border-radius: var(--radius);\n  box-shadow: var(--shadow);\n  cursor: grab;\n  touch-action: none;\n  user-select: none;\n  position: relative;\n  z-index: 1;\n}\n.capsule.dragging { cursor: grabbing; }\n\n.mark {\n  flex: none;\n  width: 26px;\n  height: 26px;\n  border-radius: 7px;\n  display: grid;\n  place-items: center;\n  background: var(--emerald);\n  color: var(--on-accent);\n  font: 600 15px/1 var(--sans);\n  letter-spacing: -.02em;\n}\n\n.face { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n.status { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--text2); white-space: nowrap; }\n.status > span:first-of-type { overflow: hidden; text-overflow: ellipsis; }\n.tick { flex: none; font-family: var(--mono); font-size: 11.5px; color: var(--text3); }\n.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text3); }\n.capsule[data-tone='wait'] .dot { background: var(--emerald); animation: pulse 1.6s var(--ease-out) infinite; }\n.capsule[data-tone='ok'] .dot { background: var(--emerald); }\n.capsule[data-tone='warn'] .dot { background: var(--amber); }\n.capsule[data-tone='error'] .dot { background: var(--rose); }\n.capsule[data-tone='warn'] .status > span:first-of-type { color: var(--amber); }\n.capsule[data-tone='error'] .status > span:first-of-type { color: var(--rose); }\n@keyframes pulse {\n  0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--emerald) 55%, transparent); }\n  100% { box-shadow: 0 0 0 6px transparent; }\n}\n\n.value-slot { position: relative; height: 26px; min-width: 0; }\n.value-slot.rolling { overflow: hidden; }\n.value {\n  position: absolute;\n  inset: 0;\n  display: block;\n  width: 100%;\n  text-align: left;\n  overflow: hidden;\n  white-space: nowrap;\n  text-overflow: ellipsis;\n  font: 500 15px/26px var(--sans);\n  color: var(--text);\n  cursor: pointer;\n  user-select: text;\n}\n.value.leaving { pointer-events: none; }\n.value[data-kind='code'] { font: 600 24px/26px var(--mono); letter-spacing: .14em; color: var(--emerald); }\n.value[data-kind='address'] { font: 500 13px/26px var(--mono); letter-spacing: -.02em; }\n.value[data-kind='domain'] { font: 500 16px/26px var(--sans); }\n.value[data-kind='muted'] { color: var(--text3); font-weight: 400; cursor: default; }\n\n/* The one primary of the capsule. */\n.cta {\n  flex: none;\n  height: 36px;\n  padding: 0 14px;\n  border-radius: var(--radius-sm);\n  background: var(--emerald);\n  color: var(--on-accent);\n  font: 600 13px/1 var(--sans);\n  white-space: nowrap;\n  position: relative;\n  transition: background-color 180ms var(--ease-out), color 180ms var(--ease-out);\n}\n.cta:hover { background: var(--emerald-hover); }\n.cta.quiet { background: var(--bg3); color: var(--text); box-shadow: inset 0 0 0 1px var(--border); }\n.cta.quiet:hover { background: color-mix(in oklab, var(--text) 8%, var(--bg3)); }\n.cta[data-loading], .cta:disabled { cursor: progress; }\n\n[data-loading] { color: transparent !important; }\n[data-loading]::after {\n  content: '';\n  position: absolute;\n  inset: 0;\n  margin: auto;\n  width: 14px;\n  height: 14px;\n  border-radius: 50%;\n  border: 2px solid;\n  border-color: var(--on-accent) var(--on-accent) transparent transparent;\n  animation: spin .7s linear infinite;\n}\n.btn[data-loading]::after { border-color: var(--text2) var(--text2) transparent transparent; }\n.btn.primary[data-loading]::after { border-color: var(--on-accent) var(--on-accent) transparent transparent; }\n@keyframes spin { to { transform: rotate(360deg); } }\n\n.icon {\n  flex: none;\n  width: 30px;\n  height: 30px;\n  display: grid;\n  place-items: center;\n  border-radius: var(--radius-sm);\n  color: var(--text2);\n  transition: background-color 180ms var(--ease-out), color 180ms var(--ease-out);\n}\n.icon:hover { background: var(--bg3); color: var(--text); }\n.icon.sm { width: 26px; height: 26px; }\n[data-action='drawer'] .ico { transition: transform var(--spring-ms) var(--spring); }\n[data-action='drawer'][aria-expanded='true'] .ico { transform: rotate(180deg); }\n\n/* ---------------------------------------------------------------- drawer\n   grid-template-rows 0fr ⇄ 1fr: one transition, so closing is the opening\n   played backwards, and nothing waits on an end event. */\n.drawer {\n  display: grid;\n  grid-template-rows: 0fr;\n  margin-top: 0;\n  opacity: 0;\n  visibility: hidden;\n  transition:\n    grid-template-rows var(--spring-ms) var(--spring),\n    margin-top var(--spring-ms) var(--spring),\n    opacity 180ms var(--ease-out),\n    visibility 0s linear var(--spring-ms);\n}\n.drawer[data-open='true'] {\n  grid-template-rows: 1fr;\n  margin-top: 6px;\n  opacity: 1;\n  visibility: visible;\n  transition:\n    grid-template-rows var(--spring-ms) var(--spring),\n    margin-top var(--spring-ms) var(--spring),\n    opacity 180ms var(--ease-out),\n    visibility 0s linear 0s;\n}\n.drawer-clip { min-height: 0; overflow: hidden; }\n.drawer-body {\n  background: var(--bg2);\n  border: 1px solid var(--border);\n  border-radius: var(--radius);\n  box-shadow: var(--shadow);\n  margin-bottom: 14px;\n  max-height: calc(100vh - 110px);\n  max-height: calc(100dvh - 110px);\n  overflow-y: auto;\n  overscroll-behavior: contain;\n  scrollbar-width: thin;\n  scrollbar-color: var(--border2) transparent;\n}\n\n.pane { display: flex; flex-direction: column; }\n.pane > * { padding-left: 14px; padding-right: 14px; }\n\n.line { display: flex; align-items: center; gap: 10px; min-height: 44px; border-bottom: 1px solid var(--border); }\n.line.head { min-height: 40px; }\n.line.edit { gap: 8px; padding-top: 8px; padding-bottom: 8px; }\n.key { flex: none; width: 44px; font-size: 12px; color: var(--text2); }\n/* English labels (Language, Provider, Shortcut) are longer than two characters. */\n:host([lang='en']) .key { width: auto; min-width: 60px; }\n.val { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 14px; }\n.val.missing { color: var(--amber); }\n.mono { font-family: var(--mono); font-size: 13px; letter-spacing: -.01em; }\n.muted { color: var(--text3); }\n.title { font-weight: 600; font-size: 14px; flex: 1; }\n.time { margin-left: auto; font: 12px var(--mono); color: var(--text3); }\n\n.block { padding-top: 10px; padding-bottom: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }\n.block > .line { border-bottom: 0; min-height: 28px; }\n.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n.row.end { justify-content: flex-end; }\n.stack { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding-top: 8px; padding-bottom: 10px; }\n\nselect, input {\n  height: 32px;\n  min-width: 0;\n  padding: 0 10px;\n  background: var(--bg2);\n  border: 1px solid var(--border);\n  border-radius: var(--radius-sm);\n  font-size: 13px;\n  outline: none;\n  transition: border-color 180ms var(--ease-out), box-shadow 180ms var(--ease-out);\n}\nselect:hover, input:hover { border-color: var(--border2); }\nselect:focus-visible, input:focus-visible { border-color: var(--emerald); box-shadow: var(--focus-ring); }\n.line select { flex: 1; }\n.line.edit input { flex: 1; }\ninput::placeholder { color: var(--text3); }\n\n.btn {\n  height: 32px;\n  padding: 0 12px;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  border-radius: var(--radius-sm);\n  background: var(--bg3);\n  border: 1px solid var(--border);\n  font: 500 13px/1 var(--sans);\n  white-space: nowrap;\n  position: relative;\n  transition: background-color 180ms var(--ease-out), border-color 180ms var(--ease-out);\n}\n.btn:hover { border-color: var(--border2); background: color-mix(in oklab, var(--text) 5%, var(--bg3)); }\n.btn.primary { background: var(--emerald); border-color: var(--emerald); color: var(--on-accent); }\n.btn.primary:hover { background: var(--emerald-hover); border-color: var(--emerald-hover); }\n.btn.danger { background: transparent; border-color: var(--rose); color: var(--rose); }\n.btn.danger:hover { background: color-mix(in oklab, var(--rose) 12%, transparent); }\n.btn.grow { flex: 1; }\n.btn:disabled { opacity: .5; cursor: not-allowed; }\n\n.link {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: 28px;\n  padding: 0 4px;\n  margin-left: -4px;\n  border-radius: 5px;\n  font-size: 13px;\n  color: var(--text2);\n}\n.link:hover { color: var(--text); }\n.row .link:last-child:not(:first-child) { margin-left: auto; }\n\n.note { font-size: 12px; color: var(--text2); padding-top: 8px; padding-bottom: 8px; }\n.note.warn { color: var(--amber); }\n.note.banner { order: 0; margin: 10px 14px 2px; padding: 8px 10px; border-radius: var(--radius-sm); font-size: 12.5px; color: var(--rose); background: color-mix(in oklab, var(--rose) 10%, var(--bg2)); }\n.note.banner[data-tone='warn'] { color: var(--amber); background: color-mix(in oklab, var(--amber) 10%, var(--bg2)); }\n.note.error { color: var(--rose); background: color-mix(in oklab, var(--rose) 10%, var(--bg2)); border-radius: var(--radius-sm); margin: 4px 14px; padding: 8px 10px; }\n.lead { font-size: 13px; color: var(--text2); padding-top: 14px; padding-bottom: 6px; }\n.field { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; padding-bottom: 4px; }\n.field > span { font-size: 12px; font-weight: 500; color: var(--text2); }\n.pane[data-pane='connect'] .row.end { padding-top: 10px; padding-bottom: 14px; }\n\n.confirm { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: var(--radius-sm); background: color-mix(in oklab, var(--rose) 8%, var(--bg2)); }\n.confirm p { font-size: 13px; }\n\n.subject { font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }\n.from { font-size: 12px; color: var(--text2); overflow-wrap: anywhere; margin-top: -6px; }\n.codes { display: flex; flex-direction: column; gap: 6px; }\n.codes li { display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'code acts' 'ctx acts'; align-items: center; column-gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg3); }\n.codes .code { grid-area: code; font: 600 18px/1.3 var(--mono); letter-spacing: .1em; color: var(--emerald); overflow-wrap: anywhere; user-select: text; }\n.codes .context { grid-area: ctx; font-size: 12px; color: var(--text2); overflow-wrap: anywhere; }\n.codes .acts { grid-area: acts; display: flex; gap: 6px; }\n.codes .btn { height: 28px; padding: 0 10px; background: var(--bg2); }\n.linkrow { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg3); }\n.linkrow .val { font-weight: 500; }\n.linkrow .btn { height: 28px; padding: 0 10px; background: var(--bg2); }\n.body {\n  margin: 0;\n  max-height: 200px;\n  overflow: auto;\n  padding: 10px;\n  border-radius: var(--radius-sm);\n  background: var(--bg);\n  font: 12px/1.6 var(--mono);\n  color: var(--text2);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  user-select: text;\n}\n\n.finish { gap: 6px; }\n.finish .btn { height: 36px; }\n.finish .link { align-self: center; margin-left: 0; font-size: 12px; }\n\n.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; font-size: 12px; color: var(--text3); }\n.conn-now { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.foot .conn-pick { flex: 1; height: 28px; font-size: 12px; max-width: 280px; }\n\n.conns { display: flex; flex-direction: column; padding-bottom: 6px; border-bottom: 1px solid var(--border); }\n.conns .line { border-bottom: 0; }\n.conns .line .link { margin-left: auto; }\n.conn-list { display: flex; flex-direction: column; gap: 4px; }\n.conn-list li { display: flex; align-items: center; gap: 4px; border-radius: var(--radius-sm); padding-right: 4px; }\n.conn-list li.active { background: var(--bg3); }\n.conn-pick-row { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; padding: 8px 10px; border-radius: var(--radius-sm); text-align: left; }\n.conn-pick-row:hover { background: color-mix(in oklab, var(--text) 4%, transparent); }\n.conn-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.conn-list li.active .conn-name::before { content: ''; display: inline-block; width: 6px; height: 6px; margin: 0 7px 2px 0; border-radius: 50%; background: var(--emerald); }\n.conn-host { min-width: 0; font: 12px var(--mono); color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.btn.sm { height: 26px; padding: 0 8px; font-size: 12px; }\n\n.seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--radius-sm); background: var(--bg3); border: 1px solid var(--border); }\n.seg button { height: 26px; padding: 0 10px; border-radius: 5px; font-size: 12px; color: var(--text2); transition: background-color 180ms var(--ease-out), color 180ms var(--ease-out); }\n.seg button[aria-checked='true'] { background: var(--bg2); color: var(--text); box-shadow: 0 1px 2px light-dark(oklch(.2 .01 260 / .12), oklch(0 0 0 / .4)); }\n\n/* ---------------------------------------------------------------- feedback\n   Feedback borrows the status line; .sr only carries it to screen readers. */\n.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }\n.capsule[data-flash] .status > span:first-of-type { color: var(--emerald); }\n.capsule[data-flash] .dot { background: var(--emerald); animation: none; }\n\n/* Live run: the message leads, meta rows sink to the bottom and get quieter. */\n.pane[data-pane='main'][data-live='true'] > .res { order: 1; }\n.pane[data-pane='main'][data-live='true'] > .addr { order: 2; }\n.pane[data-pane='main'][data-live='true'] > .finish { order: 3; }\n.pane[data-pane='main'][data-live='true'] > .meta { order: 4; min-height: 36px; }\n.pane[data-pane='main'][data-live='true'] > .meta .val { font-size: 13px; color: var(--text2); }\n.pane[data-pane='main'][data-live='true'] > .foot { order: 5; }\n\n\n/* ---------------------------------------------------------------- edge tab */\n.tab {\n  width: 44px;\n  height: 44px;\n  display: grid;\n  place-items: center;\n  background: var(--bg2);\n  border: 1px solid var(--border);\n  box-shadow: var(--shadow);\n  border-radius: var(--radius);\n  cursor: grab;\n  touch-action: none;\n  transition: transform var(--spring-ms) var(--spring);\n}\n.tab { position: relative; }\n.tab .mark { width: 22px; height: 22px; font-size: 13px; border-radius: 6px; }\n/* New mail while tucked away: a badge, never a popup or a focus grab. */\n.tab::after {\n  content: '';\n  position: absolute;\n  top: 5px;\n  left: 5px;\n  width: 9px;\n  height: 9px;\n  border-radius: 50%;\n  background: var(--amber);\n  box-shadow: 0 0 0 2px var(--bg2);\n  opacity: 0;\n  transform: scale(.4);\n  transition: opacity 180ms var(--ease-out), transform var(--spring-ms) var(--spring);\n}\n.tab.unseen::after { opacity: 1; transform: none; }\n:host([data-dock='left']) .tab::after { left: auto; right: 5px; }\n.tab.dragging { cursor: grabbing; transition: none; }\n/* The padding is the part tucked past the edge (TAB_TUCK in panel.ts); it is\n   wider than the 10px hover slide so the tab never comes loose from the edge. */\n:host([data-dock='right']) .tab { border-radius: var(--radius) 0 0 var(--radius); border-right: 0; padding-right: 16px; }\n:host([data-dock='left']) .tab { border-radius: 0 var(--radius) var(--radius) 0; border-left: 0; padding-left: 16px; }\n:host([data-dock='right']) .tab:is(:hover, :focus-visible) { transform: translateX(-10px); }\n:host([data-dock='left']) .tab:is(:hover, :focus-visible) { transform: translateX(10px); }\n\n/* ---------------------------------------------------------------- fill ring */\n.ring {\n  position: fixed;\n  border-radius: 9px;\n  box-shadow: 0 0 0 2px var(--emerald), 0 0 0 6px color-mix(in oklab, var(--emerald) 22%, transparent);\n  pointer-events: none;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation: none !important; }\n}\n";

  // userscript/src/icons.ts
  var PATHS = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
  };
  function icon(name, size = 16) {
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
  }

  // userscript/src/layout.ts
  var EDGE_MARGIN = 8;
  var SNAP_DISTANCE = 28;
  function clampPosition(position, size, viewport) {
    const maxX = Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN);
    const maxY = Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN);
    return {
      x: Math.min(Math.max(Math.round(position.x), EDGE_MARGIN), maxX),
      y: Math.min(Math.max(Math.round(position.y), EDGE_MARGIN), maxY)
    };
  }
  function snapToEdge(position, size, viewport) {
    const leftGap = position.x - EDGE_MARGIN;
    const rightGap = viewport.width - size.width - EDGE_MARGIN - position.x;
    if (leftGap <= SNAP_DISTANCE && leftGap <= rightGap) return { ...position, x: EDGE_MARGIN };
    if (rightGap <= SNAP_DISTANCE) {
      return { ...position, x: Math.max(EDGE_MARGIN, viewport.width - size.width - EDGE_MARGIN) };
    }
    return position;
  }
  function dockPosition(position, size, viewport) {
    const side = position.x + size.width / 2 < viewport.width / 2 ? "left" : "right";
    const tucked = Math.round(size.width / 2);
    const y = Math.min(
      Math.max(Math.round(position.y), EDGE_MARGIN),
      Math.max(EDGE_MARGIN, viewport.height - size.height - EDGE_MARGIN)
    );
    return {
      side,
      position: { x: side === "left" ? -tucked : viewport.width - size.width + tucked, y }
    };
  }

  // userscript/src/panel.ts
  var MARKUP = `
<section class="shell" data-i18n-aria="ui.assistant" hidden>
  <div class="capsule" data-tone="idle">
    <span class="mark" aria-hidden="true">M</span>
    <div class="face">
      <span class="status"><i class="dot" aria-hidden="true"></i><span data-ref="status"></span><span class="tick" data-ref="tick"></span></span>
      <span class="value-slot"><button class="value" type="button" data-ref="value"></button></span>
    </div>
    <button class="icon" type="button" data-action="capsule-link" data-i18n-aria="ui.openLink" hidden>${icon("external")}</button>
    <button class="cta" type="button" data-action="primary"></button>
    <button class="icon" type="button" data-action="drawer" aria-expanded="false" data-i18n-aria="ui.expand">${icon("chevron")}</button>
    <button class="icon" type="button" data-action="fold" data-i18n-aria="ui.fold" data-i18n-title="ui.fold">${icon("close")}</button>
  </div>

  <div class="drawer" data-open="false" inert>
    <div class="drawer-clip"><div class="drawer-body">

      <div class="pane" data-pane="connect" hidden>
        <p class="lead" data-ref="connect-lead"></p>
        <label class="field"><span data-i18n="connect.label"></span><input data-ref="label" type="text" autocomplete="off" spellcheck="false" data-i18n-placeholder="connect.labelPlaceholder"></label>
        <label class="field"><span data-i18n="connect.base"></span><input data-ref="base" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="mail.example.com"></label>
        <label class="field"><span>API Key</span><input data-ref="key" type="password" autocomplete="off" spellcheck="false" placeholder="mk_..."></label>
        <p class="note warn" data-ref="insecure" data-i18n="connect.insecure" hidden></p>
        <p class="note error" data-ref="connect-error" role="alert" hidden></p>
        <div class="row end">
          <button class="btn" type="button" data-action="cancel-connect" data-ref="cancel-connect" data-i18n="connect.cancel"></button>
          <button class="btn primary" type="button" data-action="connect" data-ref="connect-submit"></button>
        </div>
      </div>

      <div class="pane" data-pane="main" hidden>
        <p class="note banner" data-ref="notice" role="alert" hidden></p>
        <div class="line meta" data-ref="site-line">
          <span class="key" data-i18n="drawer.service"></span>
          <span class="val" data-ref="service"></span>
          <button class="icon sm" type="button" data-action="edit-service" data-i18n-aria="drawer.editService" data-i18n-title="drawer.editService">${icon("pencil", 14)}</button>
        </div>
        <div class="line edit meta" data-ref="service-edit" hidden>
          <input data-ref="service-input" type="text" data-i18n-aria="drawer.serviceInput" autocomplete="off" spellcheck="false">
          <button class="btn" type="button" data-action="save-service" data-i18n="drawer.save"></button>
        </div>
        <p class="note meta" data-ref="foreign" hidden></p>

        <div class="line meta">
          <span class="key" data-i18n="drawer.provider"></span>
          <span class="val" data-ref="provider-text"></span>
          <select data-ref="provider" data-i18n-aria="drawer.providerSelect"></select>
        </div>

        <div class="block addr" data-ref="address-block">
          <div class="line">
            <span class="key" data-i18n="drawer.address"></span>
            <span class="val mono" data-ref="address"></span>
            <button class="btn sm" type="button" data-action="copy-address" data-ref="copy-inline">${icon("copy", 14)}<span data-i18n="drawer.copy"></span></button>
          </div>
          <div class="row" data-ref="address-actions">
            <button class="btn" type="button" data-action="fill-address" data-i18n="drawer.fill"></button>
            <button class="btn" type="button" data-action="copy-address">${icon("copy", 14)}<span data-i18n="drawer.copy"></span></button>
            <button class="link" type="button" data-action="replace" data-i18n="drawer.replace"></button>
          </div>
          <div class="confirm" data-ref="replace-confirm" hidden>
            <p data-i18n="drawer.replaceWarning"></p>
            <div class="row end">
              <button class="btn" type="button" data-action="cancel-replace" data-i18n="drawer.cancel"></button>
              <button class="btn danger" type="button" data-action="confirm-replace" data-i18n="drawer.replaceConfirm"></button>
            </div>
          </div>
        </div>

        <div class="block res" data-ref="result-block">
          <div class="line head">
            <span class="key" data-ref="result-title"></span>
            <span class="time" data-ref="result-time"></span>
          </div>
          <p class="subject" data-ref="subject"></p>
          <p class="from" data-ref="from"></p>
          <ul class="codes" data-ref="codes"></ul>
          <div class="linkrow" data-ref="link-row">
            <span class="val" data-ref="link-domain"></span>
            <button class="btn" type="button" data-action="open-link">${icon("external", 14)}<span data-i18n="drawer.open"></span></button>
            <button class="btn" type="button" data-action="copy-link">${icon("copy", 14)}<span data-i18n="drawer.copy"></span></button>
          </div>
          <div class="row">
            <button class="link" type="button" data-action="toggle-body" data-ref="body-toggle"></button>
            <button class="link" type="button" data-action="continue" data-ref="continue">${icon("refresh", 14)}<span data-i18n="drawer.continue"></span></button>
          </div>
          <pre class="body" data-ref="body" hidden></pre>
        </div>

        <div class="block finish" data-ref="finish">
          <div class="row">
            <button class="btn primary grow" type="button" data-action="finish" data-ref="finish-btn" data-i18n="drawer.finish"></button>
            <button class="btn" type="button" data-action="end" data-ref="end-btn" data-i18n="drawer.end"></button>
          </div>
          <button class="link" type="button" data-action="report-only" data-ref="report-only" data-i18n="drawer.reportOnly"></button>
        </div>

        <div class="foot">
          <span class="conn-now" data-ref="conn-now"></span>
          <span class="key" data-ref="conn-key" data-i18n="drawer.connection" hidden></span>
          <select class="conn-pick" data-ref="conn-pick" data-i18n-aria="drawer.switchConnection" hidden></select>
          <button class="icon sm" type="button" data-action="settings" data-i18n-aria="drawer.settings" data-i18n-title="drawer.settings">${icon("settings", 15)}</button>
        </div>
      </div>

      <div class="pane" data-pane="settings" hidden>
        <div class="line head">
          <button class="icon sm" type="button" data-action="back" data-i18n-aria="set.back">${icon("back", 15)}</button>
          <span class="title" data-i18n="set.title"></span>
        </div>
        <div class="line">
          <span class="key" data-i18n="set.appearance"></span>
          <div class="seg" role="radiogroup" data-i18n-aria="set.appearance">
            <button type="button" role="radio" data-theme-choice="system" data-i18n="set.themeSystem"></button>
            <button type="button" role="radio" data-theme-choice="light" data-i18n="set.themeLight"></button>
            <button type="button" role="radio" data-theme-choice="dark" data-i18n="set.themeDark"></button>
          </div>
        </div>
        <div class="line">
          <span class="key" data-i18n="set.language"></span>
          <div class="seg" role="radiogroup" data-i18n-aria="set.language">
            <button type="button" role="radio" data-language-choice="auto" data-i18n="set.langAuto"></button>
            <button type="button" role="radio" data-language-choice="zh" lang="zh">中文</button>
            <button type="button" role="radio" data-language-choice="en" lang="en">English</button>
          </div>
        </div>
        <div class="line">
          <span class="key" data-i18n="set.summon"></span>
          <span class="val mono" data-ref="shortcut"></span>
          <button class="btn" type="button" data-action="record-shortcut" data-i18n="set.change"></button>
        </div>
        <div class="conns">
          <div class="line head"><span class="key" data-i18n="set.connections"></span><button class="link" type="button" data-action="add-connection" data-i18n="set.addConnection"></button></div>
          <ul class="conn-list" data-ref="conn-list"></ul>
        </div>
        <div class="stack">
          <button class="link" type="button" data-action="reset-seen" data-i18n="set.resetSeen"></button>
          <button class="link" type="button" data-action="hide-visit" data-i18n="set.hideVisit"></button>
          <button class="link" type="button" data-action="hide-site" data-i18n="set.hideSite"></button>
        </div>
      </div>

    </div></div>
  </div>
  <p class="sr" role="status" aria-live="polite" data-ref="announce"></p>
</section>

<button class="tab" type="button" data-action="unfold" data-i18n-aria="ui.openAssistant" data-i18n-title="ui.openAssistant" hidden><span class="mark" aria-hidden="true">M</span></button>
<div class="ring" aria-hidden="true" hidden></div>
`;
  var SPRING = "linear(0, 0.07, 0.208, 0.362, 0.501, 0.618, 0.715, 0.788, 0.846, 0.887, 0.918, 0.942, 0.958, 0.97, 0.979, 0.985, 0.989, 0.992, 0.995, 0.996, 1)";
  var SPRING_MS = 374;
  var SHELL_MAX = 388;
  var CAPSULE_H = 60;
  var TAB_H = 44;
  var SLIDE_MS = 340;
  var TAB_SLIDE_MS = 220;
  var VALUE_STEPS = {
    code: [[22, ".1em"], [20, ".08em"], [18, ".05em"], [16, ".03em"], [15, "0"]],
    address: [[12, null]],
    domain: [[15, null], [14, null], [13, null]],
    text: [[14, null], [13, null]]
  };
  var ROLL_MS = 374;
  var TAB_TUCK = 16;
  function reducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }
  function play(element, keyframes, options) {
    const duration = Number(options.duration ?? 0);
    if (reducedMotion() || duration === 0 || typeof element.animate !== "function") return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        element.animate(keyframes, { fill: "none", ...options }).finished.then(finish, finish);
      } catch {
        finish();
      }
      setTimeout(finish, duration + 120);
    });
  }
  function shortenAddress(address, budget = 20) {
    if (address.length <= budget) return address;
    const at = address.lastIndexOf("@");
    if (at <= 0) return `${address.slice(0, budget - 1)}…`;
    const domain = address.slice(at);
    const keep = Math.max(4, budget - domain.length - 1);
    return `${address.slice(0, keep)}…${domain}`;
  }
  function relative(ms) {
    const seconds = Math.max(0, Math.round(ms / 1e3));
    if (seconds < 60) return t("time.secondsAgo", { n: seconds });
    if (seconds < 3600) return t("time.minutesAgo", { n: Math.floor(seconds / 60) });
    return t("time.hoursAgo", { n: Math.floor(seconds / 3600) });
  }
  function elapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1e3));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function expiresIn(expiresAt) {
    if (!expiresAt) return "";
    const left = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(left)) return "";
    if (left <= 0) return t("time.expired");
    const hours = Math.floor(left / 36e5);
    return hours >= 1 ? t("time.expiresHours", { n: hours }) : t("time.expiresMinutes", { n: Math.max(1, Math.round(left / 6e4)) });
  }
  function providerLabel(provider) {
    const suffix = !provider.enabled ? t("drawer.disabled") : !provider.features.pollInbox ? t("drawer.noPolling") : !provider.rateStatus.available ? provider.rateStatus.cooldownReason ? ` (${provider.rateStatus.cooldownReason})` : t("drawer.limited") : "";
    return `${provider.displayName}${suffix}`;
  }
  function providerSelectable(provider) {
    return provider.enabled && provider.features.pollInbox && provider.rateStatus.available;
  }
  function createPanel(callbacks) {
    const host = document.createElement("div");
    host.setAttribute("data-mailhub-assistant", "");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = panel_default;
    shadow.appendChild(style);
    const template = document.createElement("template");
    template.innerHTML = MARKUP.trim();
    shadow.appendChild(template.content.cloneNode(true));
    const $ = (selector) => {
      const node = shadow.querySelector(selector);
      if (!node) throw new Error(`panel node missing: ${selector}`);
      return node;
    };
    const ref = (name) => $(`[data-ref="${name}"]`);
    const shell = $(".shell");
    const capsuleNode = $(".capsule");
    const valueSlot = $(".value-slot");
    const cta = $('[data-action="primary"]');
    const drawerToggle = $('[data-action="drawer"]');
    const drawer = $(".drawer");
    const tab = $(".tab");
    const ring = $(".ring");
    const panes = {
      connect: $('[data-pane="connect"]'),
      main: $('[data-pane="main"]'),
      settings: $('[data-pane="settings"]')
    };
    const baseInput = ref("base");
    const keyInput = ref("key");
    const serviceInput = ref("service-input");
    const providerSelect = ref("provider");
    const labelInput = ref("label");
    const connPick = ref("conn-pick");
    let armedDelete = null;
    let view = null;
    let shownValue = "";
    let fullValue = "";
    let flashText = null;
    let flipToken = 0;
    function relabel() {
      host.lang = currentLang();
      for (const element of Array.from(shadow.querySelectorAll("[data-i18n]"))) {
        element.textContent = t(element.dataset.i18n);
      }
      for (const element of Array.from(shadow.querySelectorAll("[data-i18n-aria]"))) {
        element.setAttribute("aria-label", t(element.dataset.i18nAria));
      }
      for (const element of Array.from(shadow.querySelectorAll("[data-i18n-title]"))) {
        element.title = t(element.dataset.i18nTitle);
      }
      for (const element of Array.from(shadow.querySelectorAll("[data-i18n-placeholder]"))) {
        element.placeholder = t(element.dataset.i18nPlaceholder);
      }
      drawerToggle.setAttribute("aria-label", drawer.dataset.open === "true" ? t("ui.collapse") : t("ui.expand"));
      lastProviderSignature = "";
      delete connPick.dataset.signature;
    }
    let lastProviderSignature = "";
    let flashTimer = null;
    let presence = "hidden";
    let presenceToken = 0;
    let transitioning = false;
    let everShown = false;
    let panelPos = null;
    let tabPos = null;
    let ctaArmedAt = 0;
    let lastCtaAction = null;
    function viewportSize() {
      const root = document.documentElement;
      return { width: root?.clientWidth || window.innerWidth, height: root?.clientHeight || window.innerHeight };
    }
    function placeShell(position) {
      const viewport = viewportSize();
      shell.style.width = viewport.width < SHELL_MAX + 16 ? `${viewport.width - 16}px` : "";
      const rect = shell.getBoundingClientRect();
      const size = { width: rect.width || SHELL_MAX, height: rect.height || 64 };
      const wanted = position ?? { x: viewport.width - size.width - 16, y: 16 };
      const next = clampPosition(wanted, size, viewport);
      host.style.left = `${next.x}px`;
      host.style.top = `${next.y}px`;
      delete host.dataset.dock;
    }
    function tabPlacement(position) {
      const size = { width: tab.offsetWidth || 36, height: tab.offsetHeight || 44 };
      const viewport = viewportSize();
      const wanted = position ?? { x: viewport.width, y: 96 };
      const docked = dockPosition(wanted, size, viewport);
      const x = docked.side === "right" ? viewport.width - size.width + TAB_TUCK : -TAB_TUCK;
      return { position: { x, y: docked.position.y }, side: docked.side };
    }
    function placeTab(position) {
      const placed = tabPlacement(position);
      host.style.left = `${placed.position.x}px`;
      host.style.top = `${placed.position.y}px`;
      host.dataset.dock = placed.side;
    }
    function place() {
      if (!view || transitioning) return;
      if (presence === "capsule") {
        placeShell(panelPos ?? view.position);
        fitValue(ref("value"));
      } else if (presence === "tab") placeTab(tabPos ?? view.tabPosition);
    }
    function enableDrag(handle, kind) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        const start = event.target;
        if (kind === "shell" && start?.closest?.("button, input, select, a")) return;
        const rect = host.getBoundingClientRect();
        const box = kind === "shell" ? shell.getBoundingClientRect() : tab.getBoundingClientRect();
        const origin = { x: rect.left, y: rect.top };
        const pointer = { x: event.clientX, y: event.clientY };
        let position = origin;
        let moved = false;
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - pointer.x;
          const dy = moveEvent.clientY - pointer.y;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          moved = true;
          handle.classList.add("dragging");
          position = clampPosition({ x: origin.x + dx, y: origin.y + dy }, { width: box.width, height: box.height }, viewportSize());
          host.style.left = `${position.x}px`;
          host.style.top = `${position.y}px`;
          delete host.dataset.dock;
        };
        const finish = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          handle.removeEventListener("pointercancel", finish);
          handle.classList.remove("dragging");
          if (!moved) return;
          handle.addEventListener("click", (click) => {
            click.stopPropagation();
            click.preventDefault();
          }, { capture: true, once: true });
          if (kind === "shell") {
            const snapped = snapToEdge(position, { width: box.width, height: box.height }, viewportSize());
            host.style.left = `${snapped.x}px`;
            panelPos = snapped;
            callbacks.movePanel(snapped);
          } else {
            const placed = tabPlacement(position);
            tabPos = placed.position;
            callbacks.moveTab(placed.position);
            placeTab(placed.position);
          }
        };
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
        }
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish);
        handle.addEventListener("pointercancel", finish);
      });
    }
    async function setPresence(next) {
      if (next === presence) return;
      const token = ++presenceToken;
      const previous = presence;
      presence = next;
      const animate = everShown || previous !== "hidden";
      transitioning = true;
      const viewportWidth = viewportSize().width;
      const slide = (dx) => [{ transform: `translateX(${dx}px)` }, { transform: "none" }];
      const edgeOf = (rect) => rect.left + rect.width / 2 < viewportWidth / 2 ? "left" : "right";
      const offEdge = (rect) => edgeOf(rect) === "right" ? viewportWidth - rect.left + 12 : -(rect.right + 12);
      try {
        if (previous === "capsule") {
          const rect = shell.getBoundingClientRect();
          if (next === "tab") {
            tabPos = { x: edgeOf(rect) === "right" ? viewportWidth : 0, y: Math.round(rect.top + (CAPSULE_H - TAB_H) / 2) };
            callbacks.moveTab(tabPos);
          }
          await play(shell, slide(offEdge(rect)), { duration: SLIDE_MS, easing: SPRING, direction: "reverse" });
        } else if (previous === "tab") {
          const rect = tab.getBoundingClientRect();
          if (next === "capsule") {
            const x = (panelPos ?? view?.position)?.x ?? viewportWidth - (shell.offsetWidth || 388) - 16;
            panelPos = { x, y: Math.round(rect.top - (CAPSULE_H - TAB_H) / 2) };
            callbacks.movePanel(panelPos);
          }
          if (next !== "capsule") {
            const dx = host.dataset.dock === "left" ? -rect.width : rect.width;
            await play(tab, slide(dx), { duration: TAB_SLIDE_MS, easing: SPRING, direction: "reverse" });
          }
        }
        if (token !== presenceToken) return;
        shell.hidden = next !== "capsule";
        tab.hidden = next !== "tab";
        host.hidden = next === "hidden";
        if (next !== "capsule") setDrawerOpen(false);
        transitioning = false;
        place();
        if (next !== "hidden") everShown = true;
        if (!animate) return;
        if (next === "capsule") {
          await play(shell, slide(offEdge(shell.getBoundingClientRect())), { duration: SLIDE_MS, easing: SPRING });
        } else if (next === "tab") {
          const width = tab.getBoundingClientRect().width;
          await play(tab, slide(host.dataset.dock === "left" ? -width : width), { duration: TAB_SLIDE_MS, easing: SPRING });
        }
      } finally {
        if (token === presenceToken) {
          transitioning = false;
          place();
        }
      }
    }
    function setDrawerOpen(open) {
      if (drawer.dataset.open === "true" === open) return;
      drawer.dataset.open = String(open);
      drawerToggle.setAttribute("aria-expanded", String(open));
      drawerToggle.setAttribute("aria-label", open ? t("ui.collapse") : t("ui.expand"));
      if (open) drawer.removeAttribute("inert");
      else drawer.setAttribute("inert", "");
      requestAnimationFrame(() => {
        if (presence === "capsule") place();
      });
      setTimeout(() => {
        if (presence === "capsule") place();
      }, SPRING_MS + 40);
    }
    function fitValue(element) {
      element.style.fontSize = "";
      element.style.letterSpacing = "";
      if (!element.clientWidth) return;
      const steps = VALUE_STEPS[element.dataset.kind ?? ""] ?? [];
      for (const [size, tracking] of steps) {
        if (element.scrollWidth <= element.clientWidth) return;
        element.style.fontSize = `${size}px`;
        if (tracking !== null) element.style.letterSpacing = tracking;
      }
    }
    function setValue(full, kind) {
      const current2 = ref("value");
      const previousKind = current2.dataset.kind;
      current2.dataset.kind = kind;
      fullValue = full;
      const text = kind === "address" || kind === "muted" && full.includes("@") ? shortenAddress(full) : full;
      current2.setAttribute("aria-label", full);
      if (text === shownValue) return;
      const hadValue = shownValue !== "";
      shownValue = text;
      if (!hadValue || reducedMotion()) {
        flipToken += 1;
        for (const stale of Array.from(valueSlot.querySelectorAll(".leaving"))) stale.remove();
        valueSlot.classList.remove("rolling");
        current2.textContent = text;
        current2.title = kind === "code" || kind === "address" ? t("ui.clickToCopy") : "";
        fitValue(current2);
        return;
      }
      const token = ++flipToken;
      for (const stale of Array.from(valueSlot.querySelectorAll(".leaving"))) stale.remove();
      const leaving = current2.cloneNode(true);
      if (previousKind) leaving.dataset.kind = previousKind;
      leaving.removeAttribute("data-ref");
      leaving.classList.add("leaving");
      leaving.setAttribute("aria-hidden", "true");
      leaving.tabIndex = -1;
      valueSlot.appendChild(leaving);
      current2.textContent = text;
      current2.title = kind === "code" || kind === "address" ? t("ui.clickToCopy") : "";
      fitValue(current2);
      valueSlot.classList.add("rolling");
      const options = { duration: ROLL_MS, easing: SPRING };
      void Promise.all([
        play(leaving, [{ transform: "translateY(0)" }, { transform: "translateY(-100%)" }], options),
        play(current2, [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], options)
      ]).then(() => {
        leaving.remove();
        if (token === flipToken) valueSlot.classList.remove("rolling");
      });
    }
    function renderProviders(next) {
      const signature = next.providers.map((provider) => `${provider.name}:${providerSelectable(provider)}`).join("|");
      if (signature !== lastProviderSignature) {
        lastProviderSignature = signature;
        providerSelect.replaceChildren();
        const auto = document.createElement("option");
        auto.value = "auto";
        auto.textContent = t("drawer.providerAuto");
        providerSelect.appendChild(auto);
        for (const provider of next.providers) {
          const option = document.createElement("option");
          option.value = provider.name;
          option.textContent = providerLabel(provider);
          option.disabled = !providerSelectable(provider);
          providerSelect.appendChild(option);
        }
      }
      providerSelect.value = next.provider ?? "auto";
      const editable = next.plan.providerEditable;
      providerSelect.hidden = !editable;
      const text = ref("provider-text");
      text.hidden = editable;
      if (!editable) {
        const name = next.providers.find((provider) => provider.name === next.inboxProvider)?.displayName ?? next.inboxProvider ?? "—";
        const expiry = expiresIn(next.expiresAt);
        text.textContent = expiry ? `${name} · ${expiry}` : name;
      }
    }
    function renderResult(next) {
      const block = ref("result-block");
      const result = next.result;
      block.hidden = !result;
      if (!result) return;
      ref("result-title").textContent = next.resultIsPrevious ? t("drawer.previousMail") : t("drawer.mail");
      ref("result-time").dataset.at = result.receivedAt ?? "";
      ref("subject").textContent = result.subject ?? t("cap.noSubject");
      ref("from").textContent = result.from ?? "";
      const codes = ref("codes");
      codes.replaceChildren();
      const live = next.plan.addressFill;
      for (const candidate of result.candidates) {
        const item = document.createElement("li");
        const value = document.createElement("span");
        value.className = "code";
        value.textContent = candidate.value;
        item.appendChild(value);
        if (candidate.context && result.candidates.length > 1) {
          const context = document.createElement("span");
          context.className = "context";
          context.textContent = candidate.context;
          item.appendChild(context);
        }
        const actions = document.createElement("span");
        actions.className = "acts";
        if (live) {
          const fill = document.createElement("button");
          fill.type = "button";
          fill.className = "btn";
          fill.textContent = t("drawer.fill");
          fill.addEventListener("click", () => callbacks.fill("code", candidate.value));
          actions.appendChild(fill);
        }
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "btn";
        copy.innerHTML = icon("copy", 14);
        copy.append(t("drawer.copy"));
        copy.addEventListener("click", () => callbacks.copy(candidate.value));
        actions.appendChild(copy);
        item.appendChild(actions);
        codes.appendChild(item);
      }
      codes.hidden = result.candidates.length === 0;
      const linkRow = ref("link-row");
      linkRow.hidden = !result.link;
      if (result.link) {
        ref("link-domain").textContent = result.link.domain;
        ref("link-domain").title = result.link.url;
      }
      const bodyToggle = ref("body-toggle");
      bodyToggle.hidden = !result.messageId;
      bodyToggle.textContent = next.bodyVisible ? t("drawer.hideMail") : t("drawer.viewMail");
      const body = ref("body");
      body.hidden = !next.bodyVisible;
      body.textContent = next.bodyVisible ? result.bodyText ?? t("drawer.loadingBody") : "";
      ref("continue").hidden = !next.plan.canContinue;
    }
    function renderMain(next) {
      panes.main.dataset.live = String(next.plan.addressFill);
      const notice = ref("notice");
      notice.hidden = !next.noticeDetail;
      notice.textContent = next.noticeDetail ?? "";
      notice.dataset.tone = next.noticeTone ?? "";
      ref("service").textContent = next.service ?? t("drawer.serviceMissing");
      ref("service").classList.toggle("missing", !next.service);
      const foreign = ref("foreign");
      foreign.hidden = !next.foreignService;
      foreign.textContent = next.foreignService ? t("drawer.foreign", { service: next.foreignService }) : "";
      if (ref("service-edit").hidden) serviceInput.value = next.service ?? "";
      $('[data-action="edit-service"]').hidden = !next.plan.providerEditable;
      if (!next.service && next.plan.providerEditable) ref("service-edit").hidden = false;
      renderProviders(next);
      ref("address-block").hidden = !next.plan.showAddress || !next.address;
      ref("address").textContent = next.address ?? "";
      ref("address").classList.toggle("muted", !next.plan.addressFill);
      ref("address-actions").hidden = !next.plan.addressFill;
      ref("copy-inline").hidden = next.plan.addressFill;
      $('[data-action="replace"]').hidden = !next.plan.canReplace || next.confirmReplace;
      ref("replace-confirm").hidden = !next.confirmReplace;
      renderResult(next);
      const finish = ref("finish");
      finish.hidden = next.plan.finish === "none";
      ref("finish-btn").hidden = next.plan.finish !== "full";
      ref("report-only").hidden = next.plan.finish !== "full";
      ref("end-btn").classList.toggle("primary", next.plan.finish === "end-only");
      ref("end-btn").classList.toggle("grow", next.plan.finish === "end-only");
      const many = next.connections.length > 1;
      ref("conn-now").hidden = many;
      ref("conn-now").textContent = next.connectionLabel ? t("drawer.connectionNow", { name: next.connectionLabel }) : "";
      connPick.hidden = !many;
      ref("conn-key").hidden = !many;
      if (many) {
        const signature = next.connections.map((entry) => `${entry.id}:${entry.title}`).join("|");
        if (connPick.dataset.signature !== signature) {
          connPick.dataset.signature = signature;
          connPick.replaceChildren(...next.connections.map((entry) => {
            const option = document.createElement("option");
            option.value = entry.id;
            option.textContent = entry.title === entry.host ? entry.title : `${entry.title} · ${entry.host}`;
            return option;
          }));
        }
        connPick.value = next.connections.find((entry) => entry.active)?.id ?? "";
      }
    }
    function renderSettings(next) {
      for (const button of Array.from(shadow.querySelectorAll("[data-theme-choice]"))) {
        button.setAttribute("aria-checked", String(button.dataset.themeChoice === next.theme));
      }
      for (const button of Array.from(shadow.querySelectorAll("[data-language-choice]"))) {
        button.setAttribute("aria-checked", String(button.dataset.languageChoice === next.language));
      }
      ref("shortcut").textContent = next.shortcut;
      const list = ref("conn-list");
      list.replaceChildren(...next.connections.map((entry) => {
        const item = document.createElement("li");
        item.classList.toggle("active", entry.active);
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "conn-pick-row";
        pick.setAttribute("aria-pressed", String(entry.active));
        pick.title = entry.active ? t("set.currentConnection") : t("set.switchTo");
        const name = document.createElement("span");
        name.className = "conn-name";
        name.textContent = entry.title;
        const host2 = document.createElement("span");
        host2.className = "conn-host";
        host2.textContent = entry.title === entry.host ? entry.active ? t("set.current") : "" : entry.host;
        pick.append(name, host2);
        pick.addEventListener("click", () => callbacks.switchConnection(entry.id));
        const editButton = document.createElement("button");
        editButton.type = "button";
        editButton.className = "icon sm";
        editButton.setAttribute("aria-label", t("set.editNamed", { name: entry.title }));
        editButton.title = t("set.edit");
        editButton.innerHTML = icon("pencil", 14);
        editButton.addEventListener("click", () => callbacks.editConnection(entry.id));
        const remove = document.createElement("button");
        remove.type = "button";
        const armed = armedDelete?.id === entry.id && Date.now() - armedDelete.at < 4e3;
        remove.className = armed ? "btn danger sm" : "icon sm";
        remove.setAttribute("aria-label", armed ? t("set.deleteConfirmNamed", { name: entry.title }) : t("set.deleteNamed", { name: entry.title }));
        remove.title = armed ? t("set.deleteAgain") : t("set.delete");
        if (armed) remove.textContent = t("set.deleteConfirm");
        else remove.innerHTML = icon("trash", 14);
        remove.addEventListener("click", () => {
          if (armedDelete?.id === entry.id && Date.now() - armedDelete.at < 4e3) {
            armedDelete = null;
            callbacks.deleteConnection(entry.id);
            return;
          }
          armedDelete = { id: entry.id, at: Date.now() };
          renderSettings(next);
          setTimeout(() => {
            if (armedDelete?.id === entry.id && view) {
              armedDelete = null;
              renderSettings(view);
            }
          }, 4100);
        });
        item.append(pick, editButton, remove);
        return item;
      }));
    }
    function renderConnect(next) {
      const form = next.connect;
      if (!form) return;
      if (shadow.activeElement !== labelInput) labelInput.value = form.label;
      if (shadow.activeElement !== baseInput) baseInput.value = form.baseUrl;
      ref("connect-lead").textContent = form.editingId ? t("connect.leadEdit") : next.connections.length ? t("connect.leadAdd") : t("connect.leadFirst");
      ref("connect-submit").textContent = form.editingId ? t("connect.submitEdit") : next.connections.length ? t("connect.submitAdd") : t("connect.submitFirst");
      if (shadow.activeElement !== keyInput) keyInput.value = form.apiKey;
      ref("insecure").hidden = !form.insecure;
      const error = ref("connect-error");
      error.hidden = !form.error;
      error.textContent = form.error ?? "";
      const submit = $('[data-action="connect"]');
      submit.disabled = form.busy;
      submit.toggleAttribute("data-loading", form.busy);
      ref("cancel-connect").hidden = next.connections.length === 0;
    }
    function renderCapsule(next) {
      const capsule = next.capsule;
      capsuleNode.dataset.tone = capsule.tone;
      if (next.mode === "connect") {
        ref("status").textContent = t("cap.notConnected");
        setValue(t("cap.connectTitle"), "muted");
        cta.hidden = true;
        return;
      }
      ref("status").textContent = flashText ?? capsule.status;
      capsuleNode.toggleAttribute("data-flash", flashText !== null);
      ref("tick").dataset.since = !flashText && capsule.ticking && next.waitingSince ? String(next.waitingSince) : "";
      setValue(capsule.value.text, capsule.value.kind);
      const linkButton = $('[data-action="capsule-link"]');
      linkButton.hidden = !capsule.link;
      linkButton.title = capsule.link ? t("ui.openLinkTo", { domain: capsule.link.domain }) : "";
      const primary = capsule.primary;
      cta.hidden = !primary;
      if (!primary) return;
      if (primary.action !== lastCtaAction) {
        if (lastCtaAction !== null) ctaArmedAt = Date.now() + 700;
        lastCtaAction = primary.action;
      }
      cta.textContent = primary.label;
      cta.dataset.action = "primary";
      cta.dataset.intent = primary.action;
      cta.classList.toggle("quiet", primary.quiet);
      cta.toggleAttribute("data-loading", primary.busy);
      cta.disabled = primary.busy;
    }
    function render(next) {
      view = next;
      host.dataset.theme = next.theme;
      host.style.colorScheme = next.theme === "system" ? "light dark" : next.theme;
      tab.classList.toggle("unseen", next.unseen);
      renderCapsule(next);
      const pane = next.mode === "connect" ? "connect" : next.drawer === "settings" ? "settings" : "main";
      panes.connect.hidden = pane !== "connect";
      panes.main.hidden = pane !== "main";
      panes.settings.hidden = pane !== "settings";
      if (pane === "connect") renderConnect(next);
      if (pane === "main") renderMain(next);
      if (pane === "settings") renderSettings(next);
      const leavingCapsule = presence === "capsule" && next.presence !== "capsule";
      if (!leavingCapsule) setDrawerOpen(next.mode === "connect" || next.drawer !== "closed");
      void setPresence(next.presence);
      if (next.presence !== "hidden") place();
      tick();
    }
    function tick() {
      const now = Date.now();
      const tickNode = ref("tick");
      const since = Number(tickNode.dataset.since || 0);
      tickNode.textContent = since ? ` · ${elapsed(now - since)}` : "";
      const timeNode = ref("result-time");
      const at = Date.parse(timeNode.dataset.at || "");
      timeNode.textContent = Number.isFinite(at) ? relative(now - at) : "";
    }
    const ticker = setInterval(() => {
      if (presence === "capsule") tick();
    }, 1e3);
    function flash(message) {
      flashText = message;
      ref("announce").textContent = message;
      if (view) {
        renderCapsule(view);
        tick();
      }
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashText = null;
        if (view) {
          renderCapsule(view);
          tick();
        }
      }, 2200);
    }
    function highlight(target) {
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      ring.style.left = `${rect.left - 4}px`;
      ring.style.top = `${rect.top - 4}px`;
      ring.style.width = `${rect.width + 8}px`;
      ring.style.height = `${rect.height + 8}px`;
      ring.hidden = false;
      const frames = [{ opacity: 0, transform: "scale(1.04)" }, { opacity: 1, transform: "none" }];
      void (async () => {
        await play(ring, frames, { duration: 220, easing: "cubic-bezier(.23,1,.32,1)" });
        await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? 900 : 700));
        await play(ring, frames, { duration: 220, easing: "cubic-bezier(.23,1,.32,1)", direction: "reverse" });
        ring.hidden = true;
      })();
    }
    const onClick = (event) => {
      const target = event.target;
      const themeChoice = target?.closest?.("[data-theme-choice]");
      if (themeChoice) {
        callbacks.setTheme(themeChoice.dataset.themeChoice);
        return;
      }
      const languageChoice = target?.closest?.("[data-language-choice]");
      if (languageChoice) {
        callbacks.setLanguage(languageChoice.dataset.languageChoice);
        return;
      }
      if (target?.closest?.('[data-ref="value"]') && view) {
        const kind = view.capsule.value.kind;
        if (kind === "code" || kind === "address" || kind === "muted") callbacks.copy(fullValue);
        return;
      }
      const button = target?.closest?.("button[data-action]");
      if (!button || !view) return;
      const result = view.result;
      switch (button.dataset.action) {
        case "primary": {
          const intent = button.dataset.intent;
          if (!intent || Date.now() < ctaArmedAt) return;
          callbacks.primary(intent);
          return;
        }
        case "drawer":
          callbacks.setDrawer(view.drawer === "closed" ? "main" : "closed");
          return;
        case "fold":
          callbacks.fold();
          return;
        case "unfold":
          callbacks.unfold();
          return;
        case "connect":
          callbacks.submitConnection({ label: labelInput.value, baseUrl: baseInput.value, apiKey: keyInput.value });
          return;
        case "add-connection":
          callbacks.addConnection();
          return;
        case "cancel-connect":
          callbacks.cancelConnection();
          return;
        case "edit-service": {
          const edit = ref("service-edit");
          edit.hidden = !edit.hidden;
          if (!edit.hidden) {
            serviceInput.value = view.service ?? "";
            serviceInput.focus();
            serviceInput.select();
          }
          return;
        }
        case "save-service":
          saveService();
          return;
        case "fill-address":
          if (view.address) callbacks.fill("email", view.address);
          return;
        case "copy-address":
          if (view.address) callbacks.copy(view.address);
          return;
        case "replace":
          callbacks.askReplace();
          return;
        case "cancel-replace":
          callbacks.cancelReplace();
          return;
        case "confirm-replace":
          callbacks.confirmReplace();
          return;
        case "open-link":
          if (result?.link) callbacks.openLink(result.link.url);
          return;
        case "capsule-link":
          if (view.capsule.link) callbacks.openLink(view.capsule.link.url);
          return;
        case "copy-link":
          if (result?.link) callbacks.copy(result.link.url);
          return;
        case "toggle-body":
          callbacks.toggleBody();
          return;
        case "continue":
          callbacks.continuePolling();
          return;
        case "finish":
          callbacks.finish();
          return;
        case "end":
          callbacks.endUse();
          return;
        case "report-only":
          callbacks.reportOnly();
          return;
        case "settings":
          callbacks.setDrawer("settings");
          return;
        case "back":
          callbacks.setDrawer("main");
          return;
        case "record-shortcut":
          callbacks.recordShortcut();
          return;
        case "reset-seen":
          callbacks.resetSeen();
          return;
        case "hide-visit":
          callbacks.hideForVisit();
          return;
        case "hide-site":
          callbacks.hideSite();
          return;
        default:
          return;
      }
    };
    function saveService() {
      const value = serviceInput.value.trim();
      if (!value) return;
      ref("service-edit").hidden = true;
      callbacks.saveService(value);
    }
    const onChange = (event) => {
      if (event.target === providerSelect) callbacks.selectProvider(providerSelect.value === "auto" ? null : providerSelect.value);
      if (event.target === connPick) callbacks.switchConnection(connPick.value);
    };
    const onKeyDown = (event) => {
      const keyboard = event;
      if (keyboard.key === "Escape" && view && view.drawer !== "closed" && view.mode !== "connect") {
        keyboard.stopPropagation();
        callbacks.setDrawer(view.drawer === "settings" ? "main" : "closed");
        cta.focus();
        return;
      }
      if (keyboard.key !== "Enter") return;
      const target = keyboard.target;
      if (target === baseInput || target === keyInput || target === labelInput) {
        keyboard.preventDefault();
        callbacks.submitConnection({ label: labelInput.value, baseUrl: baseInput.value, apiKey: keyInput.value });
      } else if (target === serviceInput) {
        keyboard.preventDefault();
        saveService();
      }
    };
    relabel();
    shadow.addEventListener("click", onClick);
    shadow.addEventListener("change", onChange);
    shadow.addEventListener("keydown", onKeyDown);
    enableDrag(capsuleNode, "shell");
    enableDrag(tab, "tab");
    return {
      host,
      render,
      flash,
      highlight,
      relabel,
      reclamp: place,
      destroy() {
        clearInterval(ticker);
        shadow.removeEventListener("click", onClick);
        shadow.removeEventListener("change", onChange);
        shadow.removeEventListener("keydown", onKeyDown);
        if (flashTimer) clearTimeout(flashTimer);
        host.remove();
      }
    };
  }

  // userscript/src/shortcut.ts
  var MODIFIER_CODES = /^(Alt|Control|Shift|Meta|OS|Super)/;
  function keyFromCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return code;
  }
  function shortcutFromEvent(event) {
    if (!event.code || MODIFIER_CODES.test(event.code)) return null;
    if (!event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) return null;
    return {
      alt: event.altKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      key: keyFromCode(event.code)
    };
  }
  function formatShortcut(spec) {
    const parts = [];
    if (spec.ctrl) parts.push("Ctrl");
    if (spec.alt) parts.push("Alt");
    if (spec.shift) parts.push("Shift");
    if (spec.meta) parts.push("Meta");
    parts.push(spec.key);
    return parts.join("+");
  }
  function parseShortcut(text) {
    const parts = String(text ?? "").split("+").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const key = parts.pop();
    const spec = { alt: false, ctrl: false, shift: false, meta: false, key };
    for (const part of parts) {
      switch (part.toLowerCase()) {
        case "alt":
          spec.alt = true;
          break;
        case "ctrl":
        case "control":
          spec.ctrl = true;
          break;
        case "shift":
          spec.shift = true;
          break;
        case "meta":
        case "cmd":
        case "command":
          spec.meta = true;
          break;
        default:
          return null;
      }
    }
    if (!spec.alt && !spec.ctrl && !spec.shift && !spec.meta) return null;
    return spec;
  }
  function matchesShortcut(event, spec) {
    const pressed = shortcutFromEvent(event);
    if (!pressed) return false;
    return pressed.alt === spec.alt && pressed.ctrl === spec.ctrl && pressed.shift === spec.shift && pressed.meta === spec.meta && pressed.key === spec.key;
  }

  // userscript/src/storage.ts
  var SESSION_VERSION = 1;
  function cloneSessionState(state) {
    return {
      ...state,
      inbox: state.inbox ? { ...state.inbox } : null,
      seenMessageIds: [...state.seenMessageIds],
      lastResult: state.lastResult ? { ...state.lastResult, codes: state.lastResult.codes.map((code) => ({ ...code })) } : null,
      page: state.page ? { ...state.page } : null
    };
  }
  function emptySessionState(init) {
    return {
      version: SESSION_VERSION,
      ownerId: init.ownerId,
      tabId: init.tabId,
      phase: "idle",
      inbox: null,
      nextProvider: null,
      reported: false,
      reportedAt: null,
      seenMessageIds: [],
      lastResult: null,
      page: null,
      requestStartedAt: null,
      updatedAt: init.now
    };
  }
  function identityId(baseUrl, apiKey) {
    return `${baseUrl.toLowerCase().replace(/\/+$/, "")}#${shortHash(apiKey)}`;
  }
  function shortHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
  function sessionKey(ownerId, tabId) {
    return `mailhub.session.${ownerId}.${tabId ?? "notab"}`;
  }
  function keyValueSessionStore(store, key) {
    return {
      async load() {
        const stored = await store.get(key, null);
        if (!stored || stored.version !== SESSION_VERSION) return null;
        return cloneSessionState(stored);
      },
      async save(state) {
        await store.set(key, cloneSessionState(state));
      },
      async clear() {
        await store.remove(key);
      }
    };
  }
  var SETTINGS_VERSION = 1;
  var SETTINGS_KEY = "mailhub.settings";
  function emptySettings() {
    return {
      version: SETTINGS_VERSION,
      theme: "system",
      language: "auto",
      mappings: {},
      enabledSites: [],
      hiddenForVisit: [],
      hiddenSites: [],
      lastProvider: {},
      panelPositions: {},
      fabPositions: {},
      shortcut: "Alt+Shift+M"
    };
  }
  async function loadSettings(store) {
    const stored = await store.get(SETTINGS_KEY, null);
    const base2 = emptySettings();
    if (!stored || stored.version !== SETTINGS_VERSION) return base2;
    return {
      ...base2,
      ...stored,
      version: SETTINGS_VERSION,
      mappings: { ...stored.mappings ?? {} },
      enabledSites: [...stored.enabledSites ?? []],
      hiddenForVisit: [...stored.hiddenForVisit ?? []],
      hiddenSites: [...stored.hiddenSites ?? []],
      lastProvider: { ...stored.lastProvider ?? {} },
      panelPositions: validPositions(stored.panelPositions),
      fabPositions: validPositions(stored.fabPositions)
    };
  }
  function validPositions(input) {
    const result = {};
    if (!input || typeof input !== "object") return result;
    for (const [key, value] of Object.entries(input)) {
      const entry = value;
      if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
      result[key] = { x: Math.round(entry.x), y: Math.round(entry.y) };
    }
    return result;
  }
  async function saveSettings(store, settings) {
    await store.set(SETTINGS_KEY, settings);
  }
  var CONNECTION_KEY = "mailhub.connection";
  async function loadConnection(store) {
    const stored = await store.get(CONNECTION_KEY, null);
    if (!stored || typeof stored.baseUrl !== "string" || typeof stored.apiKey !== "string") return null;
    if (!stored.baseUrl || !stored.apiKey) return null;
    return { baseUrl: stored.baseUrl, apiKey: stored.apiKey, insecure: stored.insecure === true };
  }
  var CONNECTIONS_KEY = "mailhub.connections";
  function emptyBook() {
    return { version: 1, activeId: null, profiles: [] };
  }
  function validProfile(value) {
    const entry = value;
    if (!entry || typeof entry.id !== "string" || typeof entry.baseUrl !== "string" || typeof entry.apiKey !== "string") return null;
    if (!entry.id || !entry.baseUrl || !entry.apiKey) return null;
    return {
      id: entry.id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : null,
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey,
      insecure: entry.insecure === true
    };
  }
  async function loadConnectionBook(store) {
    const stored = await store.get(CONNECTIONS_KEY, null);
    if (stored && stored.version === 1 && Array.isArray(stored.profiles)) {
      const profiles = stored.profiles.map(validProfile).filter((entry) => entry !== null);
      const activeId = profiles.some((entry) => entry.id === stored.activeId) ? stored.activeId ?? null : profiles[0]?.id ?? null;
      return { version: 1, activeId, profiles };
    }
    const legacy = await loadConnection(store);
    if (!legacy) return emptyBook();
    const profile = { ...legacy, id: profileId(legacy.baseUrl, legacy.apiKey), label: null };
    return { version: 1, activeId: profile.id, profiles: [profile] };
  }
  async function saveConnectionBook(store, book) {
    await store.set(CONNECTIONS_KEY, book);
  }
  function profileId(baseUrl, apiKey) {
    return `c-${shortHash(`${baseUrl.toLowerCase()}
${apiKey}`)}`;
  }
  function activeProfile(book) {
    return book.profiles.find((entry) => entry.id === book.activeId) ?? null;
  }
  function profileTitle(profile) {
    if (profile.label) return profile.label;
    try {
      return new URL(profile.baseUrl).host;
    } catch {
      return profile.baseUrl;
    }
  }
  function upsertProfile(book, input) {
    const label = input.label && input.label.trim() ? input.label.trim() : null;
    const duplicate = book.profiles.find((entry) => entry.id !== input.editingId && entry.baseUrl.toLowerCase() === input.baseUrl.toLowerCase() && entry.apiKey === input.apiKey);
    const editing = input.editingId ? book.profiles.find((entry) => entry.id === input.editingId) ?? null : null;
    const target = editing ?? duplicate ?? null;
    const profile = {
      id: target?.id ?? profileId(input.baseUrl, input.apiKey),
      label: label ?? (target && target === duplicate ? target.label : null),
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      insecure: input.insecure
    };
    let profiles = target ? book.profiles.map((entry) => entry.id === target.id ? profile : entry) : [...book.profiles, profile];
    if (editing && duplicate) profiles = profiles.filter((entry) => entry.id !== duplicate.id);
    const wasActive = target !== null && (target.id === book.activeId || editing !== null && duplicate?.id === book.activeId);
    const activeId = !editing || wasActive ? profile.id : book.activeId;
    return { book: { version: 1, activeId, profiles }, profile };
  }
  function removeProfile(book, id) {
    const profiles = book.profiles.filter((entry) => entry.id !== id);
    const activeId = book.activeId === id ? profiles[0]?.id ?? null : book.activeId;
    return { version: 1, activeId, profiles };
  }
  function selectProfile(book, id) {
    if (!book.profiles.some((entry) => entry.id === id)) return book;
    return { ...book, activeId: id };
  }

  // userscript/src/session.ts
  function htmlToText(html) {
    return html.replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ").replace(/<\s*br\s*\/?\s*>/gi, "\n").replace(/<\s*\/?\s*(p|div|li|tr|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, "&").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  }
  var UNKNOWN_OUTCOME = /* @__PURE__ */ new Set(["timeout", "network", "protocol"]);
  var ORPHANED = {
    creating: "create-unknown",
    reporting: "report-unknown",
    // Server-side close is idempotent, so "failed, retry" is safe.
    closing: "close-failed"
  };
  function isUnknownOutcome(error) {
    return error instanceof ApiError && UNKNOWN_OUTCOME.has(error.kind);
  }
  var AssistantSession = class _AssistantSession {
    client;
    store;
    now;
    current;
    /** Bumped by cancel/reset; a response from an older generation is discarded. */
    generation = 0;
    /**
     * Which write is currently in flight. A second press of the same button must
     * be a no-op rather than a second non-idempotent request.
     */
    busy = null;
    /** The in-flight phase found in storage on restore, already resolved; null otherwise. */
    recoveredFrom = null;
    constructor(deps) {
      this.client = deps.client;
      this.store = deps.store;
      this.now = deps.now ?? Date.now;
      const initial = deps.initialState ?? {
        ...emptySessionState({ ownerId: deps.ownerId, tabId: deps.tabId, now: this.now() })
      };
      this.current = {
        ...emptySessionState({ ownerId: deps.ownerId, tabId: deps.tabId, now: this.now() }),
        ...cloneSessionState({ ...initial, version: SESSION_VERSION }),
        ownerId: deps.ownerId,
        tabId: deps.tabId
      };
    }
    get state() {
      return cloneSessionState(this.current);
    }
    get inboxGeneration() {
      return this.generation;
    }
    /** Load the persisted run for this connection, if any. */
    static async restore(deps) {
      const stored = deps.initialState !== void 0 ? deps.initialState : await deps.store.load();
      if (!stored) return null;
      const resolved = ORPHANED[stored.phase];
      const initialState = resolved ? { ...stored, phase: resolved, requestStartedAt: resolved === "close-failed" ? null : stored.requestStartedAt } : stored;
      const session = new _AssistantSession({ ...deps, initialState });
      session.recoveredFrom = resolved ? stored.phase : null;
      return session;
    }
    async patch(changes) {
      this.current = {
        ...this.current,
        ...changes,
        version: SESSION_VERSION,
        updatedAt: this.now()
      };
      await this.store.save(this.current);
    }
    assertCurrent(generation) {
      if (generation !== this.generation) {
        throw new ApiError("aborted", t("err.aborted"));
      }
    }
    /**
     * Cancel whatever is in flight and stop accepting its response. Used when the
     * user closes the session, changes connection, or replaces the inbox.
     */
    cancel() {
      this.generation += 1;
    }
    /** Record the page the panel is currently on without touching the inbox. */
    notePage(page) {
      this.current = { ...this.current, page: { ...page }, updatedAt: this.now() };
    }
    /** Provider choice for the *next* allocation only. */
    selectProvider(provider) {
      this.current = { ...this.current, nextProvider: provider, updatedAt: this.now() };
    }
    async setProviders(_providers) {
    }
    async createInbox(request) {
      if (this.busy === "create") return this.state;
      const service = normalizeService(request.service);
      if (!service) throw new Error(t("err.badService"));
      const generation = ++this.generation;
      this.busy = "create";
      const previousPhase = this.current.phase;
      await this.patch({
        phase: "creating",
        requestStartedAt: this.now(),
        page: { url: this.current.page?.url ?? "", service },
        ...request.provider ? { nextProvider: request.provider } : {}
      });
      try {
        const created = await this.client.createInbox({ service, provider: request.provider });
        this.assertCurrent(generation);
        await this.patch({
          phase: "polling",
          requestStartedAt: null,
          inbox: {
            id: created.id,
            address: created.address,
            provider: created.provider,
            // The service is taken from what we asked for, not from anything the
            // page did afterwards.
            service,
            expiresAt: created.expiresAt,
            createdAt: this.now()
          },
          reported: false,
          reportedAt: null,
          seenMessageIds: [],
          lastResult: null
        });
        return this.state;
      } catch (error) {
        this.assertCurrent(generation);
        await this.patch({
          phase: isUnknownOutcome(error) ? "create-unknown" : previousPhase,
          requestStartedAt: isUnknownOutcome(error) ? this.current.requestStartedAt : null,
          page: { url: this.current.page?.url ?? "", service }
        });
        throw error;
      } finally {
        this.busy = null;
      }
    }
    async reportSuccess() {
      const inbox = this.current.inbox;
      if (!inbox) throw new Error(t("err.noInbox"));
      if (this.busy === "report") return { ok: this.current.reported, action: "in_flight" };
      if (this.current.reported || this.current.phase === "report-unknown") {
        return { ok: this.current.reported, action: "already_reported" };
      }
      const persisted = await this.store.load();
      if (persisted?.reported || persisted?.phase === "report-unknown") {
        this.current = {
          ...this.current,
          reported: persisted.reported,
          reportedAt: persisted.reportedAt,
          phase: persisted.reported ? "reported" : "report-unknown"
        };
        return { ok: persisted.reported, action: "already_reported" };
      }
      const generation = ++this.generation;
      this.busy = "report";
      const previousPhase = this.current.phase;
      await this.patch({ phase: "reporting", requestStartedAt: this.now() });
      try {
        const result = await this.client.reportSuccess(inbox.id, inbox.service);
        this.assertCurrent(generation);
        await this.patch({ phase: "reported", reported: true, reportedAt: this.now(), requestStartedAt: null });
        return result;
      } catch (error) {
        this.assertCurrent(generation);
        await this.patch({
          phase: isUnknownOutcome(error) ? "report-unknown" : previousPhase,
          requestStartedAt: isUnknownOutcome(error) ? this.current.requestStartedAt : null
        });
        throw error;
      } finally {
        this.busy = null;
      }
    }
    async closeInbox() {
      const inbox = this.current.inbox;
      if (!inbox) return null;
      if (this.busy === "close") return { ok: false, action: "in_flight" };
      if (this.current.phase === "closed") return { ok: true, action: "already_closed" };
      const generation = ++this.generation;
      this.busy = "close";
      await this.patch({ phase: "closing", requestStartedAt: this.now() });
      try {
        const result = await this.client.closeInbox(inbox.id);
        this.assertCurrent(generation);
        await this.patch({ phase: "closed", requestStartedAt: null });
        return result;
      } catch (error) {
        this.assertCurrent(generation);
        if (error instanceof ApiError && error.kind === "not-found") {
          await this.patch({ phase: "closed", requestStartedAt: null });
          return { ok: true, action: "gone" };
        }
        await this.patch({ phase: "close-failed", requestStartedAt: null });
        throw error;
      } finally {
        this.busy = null;
      }
    }
    /** Report, and only then close. A failed report never falls through to close. */
    async finishSuccessfully() {
      if (this.busy) return { reported: this.current.reported, closed: this.current.phase === "closed" };
      await this.reportSuccess();
      await this.closeInbox();
      return { reported: true, closed: true };
    }
    async pollOnce(timeoutSeconds) {
      const inbox = this.current.inbox;
      if (!inbox) throw new Error(t("err.noInbox"));
      const generation = this.generation;
      const result = await this.client.waitForCode({
        inboxId: inbox.id,
        timeoutSeconds,
        exclude: [...this.current.seenMessageIds]
      });
      if (generation !== this.generation) {
        return { ...result, stale: true, arrived: result.messageId !== null };
      }
      if (result.messageId && !this.current.seenMessageIds.includes(result.messageId)) {
        const lastResult = {
          messageId: result.messageId,
          receivedAt: result.receivedAt,
          codes: result.codes.map((code) => ({
            type: code.type,
            value: code.value,
            ...code.context ? { context: code.context } : {}
          })),
          subject: result.email?.subject ?? null,
          from: result.email?.from ?? null,
          used: false
        };
        await this.patch({
          seenMessageIds: [...this.current.seenMessageIds, result.messageId],
          // Reporting is not undone by a later message; keep the stage it reached.
          phase: this.current.phase === "reported" ? "reported" : "result",
          lastResult
        });
      }
      return { ...result, stale: false, arrived: result.messageId !== null };
    }
    /**
     * Wait for the next message. The previous result stays on record (still
     * copyable) but is no longer what the run is showing.
     */
    async continuePolling() {
      const phase = this.current.phase;
      if (!this.current.inbox || phase === "closed" || phase === "closing") return;
      if (phase === "reported" || this.current.reported) {
        await this.patch({ phase: "reported" });
        return;
      }
      await this.patch({ phase: "polling" });
    }
    /** The user acted on the result; the next step is finishing the run. */
    async markResultUsed() {
      if (!this.current.lastResult || this.current.lastResult.used) return;
      await this.patch({ lastResult: { ...this.current.lastResult, used: true } });
    }
    /** Fetch one message and reduce it to plain text for display. */
    async fetchMessage(messageId) {
      const inbox = this.current.inbox;
      if (!inbox) throw new Error(t("err.noInbox"));
      const detail = await this.client.getMessage(inbox.id, messageId);
      const text = detail.text && detail.text.trim() ? detail.text : htmlToText(detail.html ?? "");
      const bodyText = text.trim() || detail.excerpt.trim();
      return { ...detail, bodyText };
    }
    /**
     * Forget the exclusion list. Message-id exclusion is what stops a re-seen
     * message from being reported as new, but the server caps the list; dropping
     * it is therefore an explicit user action, never a silent truncation.
     */
    async resetSeen() {
      if (this.current.seenMessageIds.length === 0) return;
      await this.patch({ seenMessageIds: [] });
    }
    /** Verify a persisted inbox still exists for this identity before trusting it. */
    async verify() {
      const inbox = this.current.inbox;
      if (!inbox) return null;
      const status = await this.client.getInbox(inbox.id);
      if (status.status === "closed") {
        await this.patch({ phase: "closed" });
      }
      return status;
    }
  };

  // userscript/src/view.ts
  function stageOf(input) {
    const { phase, hasInbox, reported, hasResult } = input;
    if (phase === "creating") return "creating";
    if (phase === "create-unknown") return "create-unknown";
    if (!hasInbox) return "empty";
    switch (phase) {
      case "closing":
        return "closing";
      case "close-failed":
        return "close-failed";
      case "closed":
        return "closed";
      case "reporting":
        return "reporting";
      case "report-unknown":
        return "report-unknown";
      default:
        break;
    }
    if (reported) return "reported";
    return hasResult ? "result" : "waiting";
  }
  function isLive(stage) {
    return stage === "waiting" || stage === "result" || stage === "reported" || stage === "reporting" || stage === "report-unknown" || stage === "close-failed";
  }
  function resultShape(result) {
    if (result.candidates.length > 1) return { kind: "choose", count: result.candidates.length };
    if (result.candidates.length === 1) return { kind: "code", value: result.candidates[0].value, link: result.link };
    if (result.link) return { kind: "link", link: result.link };
    return { kind: "message", subject: result.subject };
  }
  function action(actionId, label, extra = {}) {
    return { action: actionId, label, busy: extra.busy ?? false, quiet: extra.quiet ?? false };
  }
  function resultFace(result) {
    switch (result.kind) {
      case "code":
        return { text: result.value, kind: "code" };
      case "link":
        return { text: result.link.domain, kind: "domain" };
      case "choose":
        return { text: t("cap.candidates", { n: result.count }), kind: "text" };
      case "message":
        return { text: result.subject || t("cap.noSubject"), kind: "text" };
    }
  }
  function base(input) {
    const { stage, address, service, result, addressUsed, resultUsed, providerLabel: providerLabel2 } = input;
    const addressFace = address ? { text: address, kind: "address" } : { text: t("cap.noInbox"), kind: "muted" };
    const capsule = (value, status, tone, primary, extra = {}) => ({
      value,
      status,
      tone,
      primary,
      ticking: false,
      needsDrawer: false,
      link: null,
      ...extra
    });
    switch (stage) {
      case "empty":
        return service ? capsule({ text: service, kind: "domain" }, providerLabel2, "idle", action("get", t("act.get"))) : capsule({ text: t("cap.unknownSite"), kind: "muted" }, t("cap.needService"), "warn", null, { needsDrawer: true });
      case "creating":
        return capsule(
          addressFace.kind === "address" ? { ...addressFace, kind: "muted" } : addressFace,
          t("cap.getting"),
          "wait",
          action("get", t("act.getting"), { busy: true })
        );
      case "create-unknown":
        return capsule(addressFace, t("cap.createUnknown"), "error", action("get", t("act.retryGet")));
      case "waiting":
        return capsule(
          addressFace,
          t("cap.waiting"),
          "wait",
          action("fill-address", addressUsed ? t("act.fillAgain") : t("act.fill"), { quiet: addressUsed }),
          { ticking: true }
        );
      case "result": {
        if (!result) return capsule(addressFace, t("cap.waiting"), "wait", action("fill-address", t("act.fill")), { ticking: true });
        const face = resultFace(result);
        if (result.kind === "choose") {
          return capsule(face, t("cap.choose"), "ok", action("choose", t("act.choose")), { needsDrawer: true });
        }
        if (result.kind === "message") {
          return capsule(face, t("cap.noCode"), "warn", action("view-message", t("act.viewMessage")));
        }
        if (resultUsed) return capsule(face, result.kind === "link" ? t("cap.linkOpened") : t("cap.codeFilled"), "ok", action("finish", t("act.finish")));
        return result.kind === "code" ? capsule(face, result.link ? t("cap.codeAndLink") : t("cap.codeArrived"), "ok", action("fill-code", t("act.fill")), { link: result.link }) : capsule(face, t("cap.linkArrived"), "ok", action("open-link", t("act.open")));
      }
      case "reporting":
        return capsule(result ? resultFace(result) : addressFace, t("cap.reporting"), "wait", action("finish", t("act.reportingBusy"), { busy: true }));
      case "report-unknown":
        return capsule(result ? resultFace(result) : addressFace, t("cap.reportUnknown"), "error", action("end", t("act.end")));
      case "reported":
        return capsule(result ? resultFace(result) : addressFace, t("cap.reported"), "ok", action("end", t("act.end")));
      case "closing":
        return capsule(result ? resultFace(result) : addressFace, t("cap.closing"), "wait", action("end", t("act.closingBusy"), { busy: true }));
      case "close-failed":
        return capsule(addressFace, t("cap.closeFailed"), "error", action("retry-close", t("act.retryClose")));
      case "closed":
        return capsule({ text: address ?? "—", kind: "muted" }, t("cap.closed", { provider: providerLabel2 }), "idle", action("get", t("act.getNew")));
    }
  }
  function capsuleFor(input) {
    const capsule = base(input);
    if (!input.notice) return capsule;
    return { ...capsule, status: input.notice.text, tone: input.notice.tone, ticking: false };
  }
  function drawerPlan(stage, hasResult, waiting) {
    const live = isLive(stage);
    const busy = stage === "reporting" || stage === "closing" || stage === "creating";
    return {
      providerEditable: stage === "empty" || stage === "closed" || stage === "create-unknown",
      showAddress: stage !== "empty" && stage !== "create-unknown",
      addressFill: live && !busy,
      showResult: hasResult,
      canContinue: hasResult && live && !busy && !waiting,
      finish: stage === "waiting" || stage === "result" ? "full" : stage === "reported" || stage === "report-unknown" || stage === "close-failed" ? "end-only" : "none",
      canReplace: live && !busy
    };
  }

  // userscript/src/main.ts
  var DEFAULT_SHORTCUT = "Alt+Shift+M";
  var POLL_TIMEOUT_SECONDS = 20;
  var POLL_GAP_MS = 1e3;
  var ERROR_BACKOFF_MS = 5e3;
  var POLLING_PHASES = /* @__PURE__ */ new Set(["polling", "reported"]);
  var SHOWING_RESULT = /* @__PURE__ */ new Set([
    "result",
    "reported",
    "reporting",
    "report-unknown",
    "closing",
    "close-failed",
    "closed"
  ]);
  function describeError(error) {
    if (error instanceof ApiError) {
      switch (error.kind) {
        case "unauthorized":
          return t("err.unauthorized");
        case "forbidden":
          return t("err.forbidden");
        case "not-found":
          return t("err.notFound");
        case "quota":
          return error.retryAfter ? t("err.quotaAfter", { after: error.retryAfter }) : t("err.quota");
        case "upstream":
          return t("err.upstream");
        case "network":
          return t("err.network");
        case "timeout":
          return t("err.timeout");
        case "aborted":
          return t("err.aborted");
        case "protocol":
          return t("err.protocol");
        default:
          return error.message;
      }
    }
    return error instanceof Error ? error.message : String(error);
  }
  function isUnknownOutcome2(error) {
    return error instanceof ApiError && ["timeout", "network", "protocol"].includes(error.kind);
  }
  function toPanelResult(stored, bodyText) {
    const candidates2 = stored.codes.filter((code) => code.type !== "link").map((code) => ({ value: code.value, type: code.type, context: code.context }));
    let link = null;
    const linkCode = stored.codes.find((code) => code.type === "link");
    if (linkCode) {
      try {
        const url = new URL(linkCode.value);
        if (url.protocol === "http:" || url.protocol === "https:") link = { url: url.toString(), domain: url.hostname };
      } catch {
      }
    }
    return {
      candidates: candidates2,
      link,
      subject: stored.subject,
      from: stored.from,
      receivedAt: stored.receivedAt,
      bodyText,
      messageId: stored.messageId
    };
  }
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function main() {
    if (window.top !== window.self) return;
    const gm = detectGm();
    if (!gm) return;
    const store = createGmKeyValueStore(gm);
    const settings = await loadSettings(store);
    const browserLanguages = () => navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
    setLang(resolveLang(settings.language, browserLanguages()));
    function applyLanguage() {
      setLang(resolveLang(settings.language, browserLanguages()));
      panel?.relabel();
      render();
    }
    let book = await loadConnectionBook(store);
    let connection = activeProfile(book);
    let client = null;
    let session = null;
    let panel = null;
    let pollToken = 0;
    let getting = false;
    let capturingShortcut = false;
    const ui = {
      mode: connection ? "ready" : "connect",
      connect: null,
      providers: [],
      provider: connection ? settings.lastProvider[identityId(connection.baseUrl, connection.apiKey)] ?? null : null,
      waiting: false,
      waitingSince: null,
      notice: null,
      pending: null,
      addressUsed: false,
      bodyVisible: false,
      bodies: /* @__PURE__ */ new Map(),
      drawer: "closed",
      presence: "hidden",
      confirmReplace: false,
      unseen: false
    };
    const ownerId = () => connection ? identityId(connection.baseUrl, connection.apiKey) : null;
    const pageService = () => {
      const resolved = resolveService(location.href, { mappings: settings.mappings });
      return resolved.ok ? resolved.service : null;
    };
    const siteKey = () => pageService() ?? session?.state.inbox?.service ?? "unknown";
    const persistSettings = () => saveSettings(store, settings);
    function render() {
      if (!panel) return;
      const state = session?.state ?? null;
      const inbox = state?.inbox ?? null;
      const phase = inbox && ui.pending ? ui.pending : state?.phase ?? "idle";
      const last = state?.lastResult ?? null;
      const hasResult = Boolean(last && inbox && SHOWING_RESULT.has(phase));
      const showPrevious = Boolean(last && inbox && !hasResult && phase !== "creating" && phase !== "create-unknown");
      const stage = stageOf({ phase, hasInbox: Boolean(inbox), reported: state?.reported ?? false, hasResult });
      const result = last && (hasResult || showPrevious) ? toPanelResult(last, last.messageId ? ui.bodies.get(last.messageId) ?? null : null) : null;
      const plan = drawerPlan(stage, Boolean(result), ui.waiting);
      const live = isLive(stage);
      const nextService = pageService();
      const service = live && inbox ? inbox.service : nextService;
      const capsule = capsuleFor({
        stage,
        address: inbox?.address ?? null,
        service,
        result: hasResult && result ? resultShape(result) : null,
        addressUsed: ui.addressUsed,
        resultUsed: last?.used ?? false,
        notice: ui.notice ? { text: ui.notice.text, tone: ui.notice.tone } : null,
        providerLabel: ui.provider ? ui.providers.find((provider) => provider.name === ui.provider)?.displayName ?? ui.provider : t("cap.auto")
      });
      panel.render({
        mode: ui.mode,
        connect: ui.connect,
        stage,
        capsule,
        plan,
        service,
        foreignService: live && inbox && nextService !== inbox.service ? inbox.service : null,
        providers: ui.providers,
        provider: ui.provider,
        inboxProvider: inbox?.provider ?? null,
        expiresAt: inbox?.expiresAt ?? null,
        address: inbox?.address ?? null,
        result,
        resultIsPrevious: showPrevious,
        waitingSince: ui.waiting ? ui.waitingSince : null,
        presence: ui.presence,
        drawer: ui.drawer,
        bodyVisible: ui.bodyVisible,
        confirmReplace: ui.confirmReplace,
        noticeDetail: ui.notice?.detail ?? null,
        noticeTone: ui.notice?.tone ?? null,
        unseen: ui.unseen,
        theme: settings.theme,
        language: settings.language,
        shortcut: settings.shortcut || DEFAULT_SHORTCUT,
        connectionLabel: connection ? profileTitle(connection) : null,
        connections: book.profiles.map((profile) => ({
          id: profile.id,
          title: profileTitle(profile),
          host: (() => {
            try {
              return new URL(profile.baseUrl).host;
            } catch {
              return profile.baseUrl;
            }
          })(),
          active: profile.id === book.activeId
        })),
        position: settings.panelPositions[siteKey()] ?? null,
        tabPosition: settings.fabPositions[siteKey()] ?? null
      });
    }
    async function copy(value, label = t("fb.copied")) {
      try {
        await navigator.clipboard.writeText(value);
        panel?.flash(label);
        return;
      } catch {
      }
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;opacity:0;left:-9999px";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        panel?.flash(label);
      } catch {
        panel?.flash(t("fb.copyFailed"));
      }
    }
    function setNotice(text, tone = "error", detail = null) {
      ui.notice = text ? { text, tone, detail } : null;
    }
    async function markTab(active) {
      const owner = ownerId();
      if (!owner) return;
      await writeTabState(gm, active ? { mailhubRun: owner } : {});
    }
    function stopPolling() {
      pollToken += 1;
      ui.waiting = false;
    }
    function startPolling(since = Date.now()) {
      pollToken += 1;
      const token = pollToken;
      ui.waiting = true;
      ui.waitingSince = since;
      void pollLoop(token);
    }
    async function pollLoop(token) {
      while (token === pollToken && session) {
        const state = session.state;
        if (!state.inbox || !POLLING_PHASES.has(state.phase)) break;
        try {
          const result = await session.pollOnce(POLL_TIMEOUT_SECONDS);
          if (token !== pollToken || result.stale) return;
          if (ui.notice?.tone === "warn") setNotice(null);
          if (result.arrived) {
            ui.waiting = false;
            ui.bodyVisible = false;
            if (ui.presence === "tab") ui.unseen = true;
            if (ui.presence === "capsule" && result.codes.filter((code) => code.type !== "link").length > 1) ui.drawer = "main";
            render();
            return;
          }
          render();
          await sleep(POLL_GAP_MS);
        } catch (error) {
          if (token !== pollToken) return;
          if (error instanceof ApiError && error.kind === "aborted") return;
          if (error instanceof ApiError && error.kind === "not-found") {
            ui.waiting = false;
            setNotice(t("note.inboxGone"));
            render();
            return;
          }
          if (error instanceof ApiError && error.code === "exclusions-full") {
            ui.waiting = false;
            setNotice(t("note.seenFull"), "warn", t("note.seenFullDetail"));
            render();
            return;
          }
          setNotice(t("note.pollError"), "warn", describeError(error));
          render();
          await sleep(ERROR_BACKOFF_MS);
        }
      }
      if (token === pollToken) {
        ui.waiting = false;
        render();
      }
    }
    function ensureClient() {
      if (client) return client;
      if (!connection) return null;
      client = createApiClient({ baseUrl: connection.baseUrl, apiKey: connection.apiKey, send: createGmTransport(gm) });
      return client;
    }
    async function ensureSession() {
      const api = ensureClient();
      const owner = ownerId();
      if (!api || !owner) return null;
      if (session) return session;
      const sessionStore = keyValueSessionStore(store, sessionKey(owner, null));
      session = await AssistantSession.restore({ client: api, store: sessionStore, ownerId: owner, tabId: null }) ?? new AssistantSession({ client: api, store: sessionStore, ownerId: owner, tabId: null });
      return session;
    }
    async function refreshProviders() {
      const api = ensureClient();
      if (!api) return;
      try {
        ui.providers = await api.listProviders();
        const remembered = ui.provider && ui.providers.find((provider) => provider.name === ui.provider);
        if (ui.provider && (!remembered || !remembered.enabled || !remembered.features.pollInbox)) ui.provider = null;
      } catch (error) {
        setNotice(t("note.providersFailed"), "error", describeError(error));
      }
      render();
    }
    async function hydrate() {
      if (!connection) {
        ui.mode = "connect";
        ui.connect = ui.connect ?? blankConnectForm();
        render();
        return;
      }
      ui.mode = "ready";
      const active = await ensureSession();
      render();
      if (ui.providers.length === 0) void refreshProviders();
      if (!active?.state.inbox) return;
      const phase = active.state.phase;
      if (active.recoveredFrom === "creating") {
        setNotice(t("note.createUnknown"), "error", t("note.createUnknownDetail"));
        render();
        return;
      }
      if (phase === "report-unknown") {
        setNotice(t("note.reportUnknown"), "error", t("note.reportUnknownDetail"));
        render();
        return;
      }
      if (phase === "closed") return;
      if (phase === "creating" || phase === "reporting" || phase === "closing") return;
      try {
        const status = await active.verify();
        if (status?.status === "closed") {
          stopPolling();
          render();
          return;
        }
        if (active.recoveredFrom === "closing") setNotice(t("note.closeUnknown"), "error", t("note.closeUnknownDetail"));
        if (POLLING_PHASES.has(active.state.phase) && !ui.waiting) {
          startPolling(active.state.lastResult ? Date.now() : active.state.inbox.createdAt);
        }
        render();
      } catch (error) {
        if (error instanceof ApiError && error.kind === "not-found") {
          stopPolling();
          setNotice(t("note.serverGone"));
        } else {
          setNotice(t("note.verifyFailed"), "warn", describeError(error));
        }
        render();
      }
    }
    function plaintextWarning(baseUrl) {
      if (!baseUrl) return false;
      const parsed = normalizeBaseUrl(baseUrl);
      return parsed.ok && parsed.insecure;
    }
    function blankConnectForm() {
      const servedFrom = "%%MAILHUB_ORIGIN%%".startsWith("%%") ? "" : "%%MAILHUB_ORIGIN%%";
      const baseUrl = book.profiles.length === 0 ? servedFrom : "";
      return {
        editingId: null,
        label: "",
        baseUrl,
        apiKey: "",
        insecure: plaintextWarning(baseUrl),
        error: null,
        busy: false
      };
    }
    function leaveIdentity() {
      stopPolling();
      session = null;
      client = null;
      ui.providers = [];
      ui.addressUsed = false;
      ui.bodies.clear();
      ui.bodyVisible = false;
      ui.confirmReplace = false;
      setNotice(null);
    }
    async function useProfile(profile) {
      const changed = connection?.baseUrl !== profile?.baseUrl || connection?.apiKey !== profile?.apiKey;
      if (changed) leaveIdentity();
      connection = profile;
      const owner = ownerId();
      ui.provider = owner ? settings.lastProvider[owner] ?? null : null;
      await saveConnectionBook(store, book);
      await hydrate();
    }
    async function switchConnection(id) {
      if (id === book.activeId) return;
      book = selectProfile(book, id);
      await useProfile(activeProfile(book));
      panel?.flash(t("fb.switched", { name: connection ? profileTitle(connection) : "—" }));
    }
    async function deleteConnection(id) {
      const wasActive = id === book.activeId;
      book = removeProfile(book, id);
      if (wasActive) {
        await useProfile(activeProfile(book));
        if (!connection) {
          ui.mode = "connect";
          ui.connect = blankConnectForm();
        }
      } else {
        await saveConnectionBook(store, book);
      }
      panel?.flash(t("fb.deleted"));
      render();
    }
    async function submitConnection(input) {
      const editingId = ui.connect?.editingId ?? null;
      const base2 = normalizeBaseUrl(input.baseUrl);
      const apiKey = input.apiKey.trim();
      const fail = (message, insecure = false) => {
        ui.connect = { editingId, label: input.label, baseUrl: input.baseUrl, apiKey, insecure, error: message, busy: false };
        render();
      };
      if (!base2.ok) {
        fail(base2.message);
        return;
      }
      if (!apiKey) {
        fail(t("connect.needKey"), base2.insecure);
        return;
      }
      ui.connect = { editingId, label: input.label, baseUrl: base2.baseUrl, apiKey, insecure: base2.insecure, error: null, busy: true };
      render();
      const candidate = createApiClient({ baseUrl: base2.baseUrl, apiKey, send: createGmTransport(gm) });
      try {
        await candidate.listProviders();
      } catch (error) {
        fail(describeError(error), base2.insecure);
        return;
      }
      const saved = upsertProfile(book, {
        editingId,
        label: input.label,
        baseUrl: base2.baseUrl,
        apiKey,
        insecure: base2.insecure
      });
      book = saved.book;
      ui.mode = "ready";
      ui.connect = null;
      ui.drawer = "closed";
      await useProfile(activeProfile(book));
      client = client ?? candidate;
    }
    async function getInbox() {
      if (getting) return;
      const service = pageService();
      if (!service) {
        setNotice(t("note.needService"), "warn", t("note.needServiceDetail"));
        ui.drawer = "main";
        render();
        return;
      }
      const active = await ensureSession();
      if (!active) {
        ui.mode = "connect";
        render();
        return;
      }
      getting = true;
      setNotice(null);
      ui.confirmReplace = false;
      const creating = active.createInbox({ service, provider: ui.provider });
      render();
      try {
        await creating;
        ui.addressUsed = false;
        ui.bodyVisible = false;
        await markTab(true);
        startPolling(Date.now());
      } catch (error) {
        if (isUnknownOutcome2(error)) setNotice(t("note.createUnknown"), "error", t("note.createUnknownAfter", { error: describeError(error) }));
        else setNotice(t("note.createFailed"), "error", describeError(error));
      } finally {
        getting = false;
        render();
      }
    }
    async function reportAndClose() {
      const active = session;
      if (!active?.state.inbox) return;
      setNotice(null);
      if (!active.state.reported) {
        ui.pending = "reporting";
        const reporting = active.reportSuccess();
        render();
        try {
          await reporting;
        } catch (error) {
          ui.pending = null;
          if (isUnknownOutcome2(error)) setNotice(t("note.reportUnknown"), "error", t("note.reportUnknownAfter", { error: describeError(error) }));
          else setNotice(t("note.reportFailed"), "error", t("note.reportFailedAfter", { error: describeError(error) }));
          render();
          return;
        } finally {
          ui.pending = null;
        }
      }
      await endUse();
    }
    async function reportOnly() {
      const active = session;
      if (!active?.state.inbox) return;
      setNotice(null);
      ui.pending = "reporting";
      const reporting = active.reportSuccess();
      render();
      try {
        await reporting;
        panel?.flash(t("fb.reportedKeep"));
        if (!ui.waiting) startPolling(Date.now());
      } catch (error) {
        if (isUnknownOutcome2(error)) setNotice(t("note.reportUnknown"), "error", t("note.reportUnknownKeep", { error: describeError(error) }));
        else setNotice(t("note.reportFailed"), "error", describeError(error));
      } finally {
        ui.pending = null;
      }
      render();
    }
    async function endUse() {
      const active = session;
      if (!active?.state.inbox || active.state.phase === "closed") return true;
      stopPolling();
      setNotice(null);
      ui.pending = "closing";
      const closing = active.closeInbox();
      render();
      try {
        await closing;
        ui.pending = null;
        setNotice(null);
        ui.drawer = "closed";
        ui.confirmReplace = false;
        await markTab(false);
        render();
        return true;
      } catch (error) {
        ui.pending = null;
        setNotice(t("note.closeFailed"), "error", t("note.closeFailedAfter", { error: describeError(error) }));
        render();
        return false;
      }
    }
    async function replaceInbox() {
      ui.confirmReplace = false;
      if (await endUse()) await getInbox();
    }
    async function continuePolling() {
      if (!session?.state.inbox) return;
      await session.continuePolling();
      ui.bodyVisible = false;
      setNotice(null);
      startPolling(Date.now());
      render();
    }
    async function loadBody() {
      const messageId = session?.state.lastResult?.messageId;
      if (!messageId || ui.bodies.has(messageId)) return;
      try {
        const detail = await session?.fetchMessage(messageId);
        if (detail) ui.bodies.set(messageId, detail.bodyText);
      } catch (error) {
        ui.bodies.set(messageId, t("note.readFailed", { error: describeError(error) }));
      }
      render();
    }
    async function markUsed() {
      await session?.markResultUsed();
    }
    async function fill(kind, value) {
      const outcome = fillPage(kind, value);
      if (outcome.ok) {
        if (outcome.target) panel?.highlight(outcome.target);
        if (kind === "email") ui.addressUsed = true;
        else await markUsed();
        panel?.flash(kind === "email" ? t("fb.filledEmail") : t("fb.filledCode"));
        ui.drawer = "closed";
        render();
        return;
      }
      await copy(value, kind === "email" ? t("fb.noEmailField") : t("fb.noCodeField"));
      if (kind === "code") await markUsed();
      render();
    }
    function openLink(url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        panel?.flash(t("fb.badLink"));
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        panel?.flash(t("fb.httpOnly"));
        return;
      }
      window.open(parsed.toString(), "_blank", "noopener,noreferrer");
      void markUsed().then(render);
    }
    function primary(action2) {
      const last = session?.state.lastResult ?? null;
      const inbox = session?.state.inbox ?? null;
      switch (action2) {
        case "get":
          void getInbox();
          return;
        case "fill-address":
          if (inbox) void fill("email", inbox.address);
          return;
        case "fill-code": {
          const code = last?.codes.find((entry) => entry.type !== "link");
          if (code) void fill("code", code.value);
          return;
        }
        case "open-link": {
          const link = last?.codes.find((entry) => entry.type === "link");
          if (link) openLink(link.value);
          return;
        }
        case "choose":
          ui.drawer = "main";
          render();
          return;
        case "view-message":
          ui.drawer = "main";
          ui.bodyVisible = true;
          render();
          void loadBody();
          return;
        case "finish":
          void reportAndClose();
          return;
        case "end":
        case "retry-close":
          void endUse();
          return;
      }
    }
    function setPresence(next) {
      ui.presence = next;
      if (next === "capsule") ui.unseen = false;
      if (next !== "capsule") ui.drawer = "closed";
      render();
    }
    async function mount() {
      if (panel) return;
      panel = createPanel({
        primary,
        submitConnection: (input) => {
          void submitConnection(input);
        },
        cancelConnection: () => {
          ui.mode = "ready";
          ui.connect = null;
          ui.drawer = "settings";
          render();
        },
        addConnection: () => {
          ui.mode = "connect";
          ui.connect = blankConnectForm();
          render();
        },
        editConnection: (id) => {
          const profile = book.profiles.find((entry) => entry.id === id);
          if (!profile) return;
          ui.mode = "connect";
          ui.connect = {
            editingId: profile.id,
            label: profile.label ?? "",
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            insecure: profile.insecure,
            error: null,
            busy: false
          };
          render();
        },
        switchConnection: (id) => {
          void switchConnection(id);
        },
        deleteConnection: (id) => {
          void deleteConnection(id);
        },
        fill: (kind, value) => {
          void fill(kind, value);
        },
        copy: (value) => {
          void copy(value);
          const last = session?.state.lastResult;
          if (last?.codes.some((code) => code.value === value)) void markUsed().then(render);
        },
        openLink,
        continuePolling: () => {
          void continuePolling();
        },
        finish: () => {
          void reportAndClose();
        },
        reportOnly: () => {
          void reportOnly();
        },
        endUse: () => {
          void endUse();
        },
        askReplace: () => {
          ui.confirmReplace = true;
          render();
        },
        confirmReplace: () => {
          void replaceInbox();
        },
        cancelReplace: () => {
          ui.confirmReplace = false;
          render();
        },
        saveService: (value) => {
          const page = resolveService(location.href);
          const resolved = resolveService(location.href, { mappings: settings.mappings, override: value });
          if (!resolved.ok) {
            panel?.flash(t("fb.badService"));
            return;
          }
          if (page.ok) settings.mappings[page.host] = resolved.service;
          else settings.mappings[location.hostname] = resolved.service;
          void persistSettings();
          setNotice(null);
          panel?.flash(t("fb.serviceSet", { service: resolved.service }));
          render();
        },
        selectProvider: (provider) => {
          ui.provider = provider;
          session?.selectProvider(provider);
          const owner = ownerId();
          if (owner) {
            settings.lastProvider[owner] = provider;
            void persistSettings();
          }
          render();
        },
        toggleBody: () => {
          ui.bodyVisible = !ui.bodyVisible;
          render();
          if (ui.bodyVisible) void loadBody();
        },
        setDrawer: (drawer) => {
          ui.drawer = drawer;
          render();
        },
        setTheme: (theme) => {
          settings.theme = theme;
          void persistSettings();
          render();
        },
        fold: () => setPresence("tab"),
        unfold: () => {
          setPresence("capsule");
          void hydrate();
        },
        hideForVisit: () => setPresence("hidden"),
        hideSite: () => {
          const site2 = pageService();
          if (site2 && !settings.hiddenSites.includes(site2)) {
            settings.hiddenSites.push(site2);
            void persistSettings();
          }
          setPresence("hidden");
        },
        movePanel: (position) => {
          settings.panelPositions[siteKey()] = position;
          void persistSettings();
        },
        moveTab: (position) => {
          settings.fabPositions[siteKey()] = position;
          void persistSettings();
        },
        recordShortcut: () => {
          capturingShortcut = true;
          panel?.flash(t("fb.recordShortcut"));
        },
        setLanguage: (language) => {
          settings.language = language;
          void persistSettings();
          applyLanguage();
          panel?.flash(t("fb.language"));
        },
        resetSeen: () => {
          void session?.resetSeen().then(() => {
            setNotice(null);
            panel?.flash(t("fb.seenReset"));
            if (session && POLLING_PHASES.has(session.state.phase) && !ui.waiting) startPolling(Date.now());
            render();
          });
        }
      });
      document.documentElement.appendChild(panel.host);
      trackPageFocus(panel.host);
    }
    function summon() {
      void (async () => {
        await mount();
        const site2 = pageService();
        if (site2 && !settings.enabledSites.includes(site2)) {
          settings.enabledSites.push(site2);
          void persistSettings();
        }
        if (site2) settings.hiddenSites = settings.hiddenSites.filter((entry) => entry !== site2);
        ui.presence = "capsule";
        ui.unseen = false;
        ui.drawer = "main";
        await hydrate();
      })();
    }
    window.addEventListener("keydown", (event) => {
      if (capturingShortcut) {
        if (event.key === "Escape") {
          capturingShortcut = false;
          panel?.flash(t("fb.cancelled"));
          return;
        }
        const spec2 = shortcutFromEvent(event);
        if (!spec2) {
          panel?.flash(t("fb.needModifier"));
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        capturingShortcut = false;
        settings.shortcut = formatShortcut(spec2);
        void persistSettings().then(render);
        panel?.flash(t("fb.shortcutSet", { shortcut: settings.shortcut }));
        return;
      }
      if (event.isComposing || event.repeat) return;
      const spec = parseShortcut(settings.shortcut || DEFAULT_SHORTCUT);
      if (spec && matchesShortcut(event, spec)) {
        event.preventDefault();
        summon();
      }
    }, true);
    window.addEventListener("resize", () => {
      panel?.reclamp();
    }, true);
    gm.registerMenuCommand?.(t("menu.open"), summon);
    gm.registerMenuCommand?.(t("menu.deleteConnection"), () => {
      void (async () => {
        if (book.activeId) await deleteConnection(book.activeId);
        summon();
      })();
    });
    const site = pageService();
    const hiddenHere = site !== null && settings.hiddenSites.includes(site);
    const tabState = await readTabState(gm);
    const runOwner = book.profiles.find((profile) => identityId(profile.baseUrl, profile.apiKey) === tabState.mailhubRun);
    if (runOwner && runOwner.id !== book.activeId) {
      book = selectProfile(book, runOwner.id);
      connection = runOwner;
      ui.provider = settings.lastProvider[identityId(runOwner.baseUrl, runOwner.apiKey)] ?? null;
      await saveConnectionBook(store, book);
    }
    const followsRun = Boolean(connection && tabState.mailhubRun === ownerId());
    const enabledHere = site !== null && settings.enabledSites.includes(site);
    if (connection && !hiddenHere && (enabledHere || followsRun)) {
      await mount();
      const active = await ensureSession();
      const live = Boolean(active?.state.inbox) && active?.state.phase !== "closed";
      ui.presence = live ? "capsule" : "tab";
      await hydrate();
    }
  }
  void main();
})();
