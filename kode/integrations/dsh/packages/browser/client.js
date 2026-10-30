// Generated from @deepseek-ai/dsh-client-ui-sidebar-browser 0.2.1-rc.2 (MIT). Run npm run build:browser.
window.__ModuleLoader__.load({
	id: "@kode/dsh-browser",
	factory: (require) => {
		const kodeBrowserPage = (() => { const module = {exports:{}}; const exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/browser/page-source.js
var page_source_exports = {};
__export(page_source_exports, {
  createBrowserPage: () => createBrowserPage
});
module.exports = __toCommonJS(page_source_exports);
function createBrowserPage(options) {
  const id = crypto.randomUUID(), listeners = /* @__PURE__ */ new Set();
  let snapshot = { target: void 0, address: "empty", loading: false, canGoBack: false, canGoForward: false, error: void 0, sandboxEnabled: void 0 };
  let ready = false, creating, disposed = false, host, root, image, input, stream, observer, size = { width: 800, height: 900, pixelRatio: Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)) }, revision = 0, inputChain = Promise.resolve(), inputQueue = [], drainingInput = false, navigationChain = Promise.resolve(), frameRequest, moveData, resizeTimer, densityQuery, densityListener, recovering, touch, frameViewport, feedback, feedbackTimer, composing = false;
  const publish = (patch) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const showFeedback = (text) => {
    if (!feedback) return;
    feedback.textContent = text;
    feedback.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      if (feedback) feedback.hidden = true;
    }, 2500);
  };
  const failure = (error) => publish({ loading: false, error: { code: -1, description: error.message || "\u4FA7\u680F\u6D4F\u89C8\u5668\u8FDE\u63A5\u5931\u8D25\u3002" } });
  async function api(action, data = {}) {
    const response = await fetch("/api/kode/browser", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id, ...data }), keepalive: action === "close", signal: AbortSignal.timeout(3e4) });
    let value;
    try {
      value = await response.json();
    } catch {
      throw new Error(`\u4FA7\u680F\u6D4F\u89C8\u5668\u63A5\u53E3\u6682\u4E0D\u53EF\u7528\uFF08HTTP ${response.status}\uFF09\uFF0C\u8BF7\u91CD\u65B0\u8FDE\u63A5\u5165\u53E3\u4E3B\u673A\u3002`);
    }
    if (!response.ok) {
      const gone = value.code === "BROWSER_TAB_GONE" || /标签页已关闭|标签页已回收/.test(value.error ?? "");
      if (gone) ready = false;
      throw Object.assign(new Error(value.error ?? "\u6D4F\u89C8\u5668\u64CD\u4F5C\u5931\u8D25\u3002"), { code: gone ? "BROWSER_TAB_GONE" : value.code });
    }
    return value;
  }
  function update(value) {
    let target;
    try {
      const url = new URL(value.url);
      if (["http:", "https:"].includes(url.protocol)) target = { kind: url.protocol === "https:" ? "https" : "http", url: url.href, title: value.title || url.hostname };
    } catch {
    }
    publish({ target: target ?? snapshot.target, address: target ? "observed" : "unknown", loading: Boolean(value.loading), canGoBack: Boolean(value.canGoBack), canGoForward: Boolean(value.canGoForward), error: value.error ? { code: -1, description: value.error } : void 0 });
    if (target) options.persist({ entries: [target], index: 0, request: { revision: ++revision, target }, navigation: { status: "known", revision }, failure: void 0 });
  }
  function connect() {
    stream?.close();
    if (!root || !ready || disposed) return;
    stream = new EventSource(`/api/kode/browser?stream=${encodeURIComponent(id)}`);
    stream.onmessage = (event) => {
      let value;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      if (value.type === "frame" && image) {
        frameViewport = value.viewport;
        image.src = `data:${value.mimeType === "image/png" ? "image/png" : "image/jpeg"};base64,${value.data}`;
      } else if (value.type === "state") update(value);
      else if (value.type === "open") options.openRequested(value.url);
      else if (value.type === "closed") {
        ready = false;
        stream?.close();
        void recoverPage();
      }
    };
    stream.onerror = () => {
      if (disposed) return;
      void api("heartbeat").catch((error) => {
        if (error.code === "BROWSER_TAB_GONE") void recoverPage();
        else failure(new Error("\u7F51\u9875\u753B\u9762\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE\u3002"));
      });
    };
  }
  async function ensure(target) {
    if (ready) return;
    if (!creating) creating = api("create", { url: target.url, ...size }).then((value) => {
      if (disposed) return api("close").catch(() => {
      });
      ready = true;
      return api("resize", size).then(() => {
        update(value);
        connect();
      });
    }).finally(() => {
      creating = void 0;
    });
    await creating;
  }
  function recoverPage() {
    if (disposed || !root || !snapshot.target) return Promise.resolve();
    if (!recovering) {
      ready = false;
      stream?.close();
      publish({ loading: true, error: void 0 });
      recovering = ensure(snapshot.target).catch(failure).finally(() => {
        recovering = void 0;
      });
    }
    return recovering;
  }
  function copySelection() {
    return inputChain.then(() => api("selection")).then(async (value) => {
      if (!value.text) return showFeedback("\u8BF7\u5148\u9009\u4E2D\u7F51\u9875\u91CC\u7684\u6587\u5B57");
      if (!navigator.clipboard?.writeText) return showFeedback("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u5141\u8BB8\u8BBF\u95EE\u526A\u8D34\u677F");
      await navigator.clipboard.writeText(value.text);
      showFeedback("\u5DF2\u590D\u5236");
    }).catch((error) => showFeedback(error.message));
  }
  function command(action, data = {}) {
    const last = inputQueue.at(-1);
    if (action === "pointer" && last?.action === action && last.data.type === data.type && last.data.buttons === data.buttons && ["mouseMoved", "mouseWheel"].includes(data.type)) {
      last.data = data.type === "mouseWheel" ? { ...data, deltaX: last.data.deltaX + data.deltaX, deltaY: last.data.deltaY + data.deltaY } : data;
    } else inputQueue.push({ action, data });
    if (!drainingInput) {
      drainingInput = true;
      inputChain = inputChain.catch(() => {
      }).then(async () => {
        try {
          while (inputQueue.length) {
            const next = inputQueue.shift();
            if (disposed) continue;
            try {
              if (ready) await api(next.action, next.data);
              else await recoverPage();
            } catch (error) {
              inputQueue.length = 0;
              if (error.code === "BROWSER_TAB_GONE") await recoverPage();
              else failure(error);
            }
          }
        } finally {
          drainingInput = false;
        }
      });
    }
    return inputChain;
  }
  function coordinates(event) {
    const bounds = root.getBoundingClientRect();
    const width = image?.naturalWidth || size.width, height = image?.naturalHeight || size.height;
    const scale = Math.min(bounds.width / width, bounds.height / height), pageScale = frameViewport?.scale || 1;
    const x = (event.clientX - bounds.left - (bounds.width - width * scale) / 2) / scale;
    const y = (event.clientY - bounds.top - (bounds.height - height * scale) / 2) / scale;
    return { x: x * (frameViewport?.width || size.width) / width / pageScale, y: (y * (frameViewport?.height || size.height) / height - (frameViewport?.offsetTop || 0)) / pageScale };
  }
  function pointer(event, type) {
    if (!root || !ready) return;
    if (type !== "mouseMoved") event.preventDefault();
    if (type === "mousePressed") input?.focus({ preventScroll: true });
    const data = { type, ...coordinates(event), button: ["left", "middle", "right"][event.button] ?? "none", buttons: event.buttons, clickCount: event.detail || 1 };
    if (type === "mouseWheel") Object.assign(data, { button: "none", deltaX: event.deltaX, deltaY: event.deltaY });
    if (type === "mouseMoved") {
      moveData = data;
      if (frameRequest) return;
      frameRequest = requestAnimationFrame(() => {
        frameRequest = void 0;
        const latest = moveData;
        moveData = void 0;
        if (latest) void command("pointer", latest);
      });
    } else {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = void 0;
      moveData = void 0;
      void command("pointer", data);
    }
  }
  const heartbeat = setInterval(() => {
    if (ready && !disposed) void api("heartbeat").catch((error) => {
      if (error.code === "BROWSER_TAB_GONE" && root) void recoverPage();
    });
  }, 2e4);
  const frame = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadUrl(target) {
      publish({ target, address: "requested", loading: true, error: void 0 });
      navigationChain = navigationChain.catch(() => {
      }).then(async () => {
        if (disposed) return;
        const existing = ready;
        await ensure(target);
        if (existing) await command("navigate", { url: target.url });
      }).catch(failure);
    },
    goBack: () => {
      void command("back");
    },
    goForward: () => {
      void command("forward");
    },
    reload: () => {
      if (ready) {
        publish({ error: void 0, loading: true });
        void command("reload");
      } else if (snapshot.target) frame.loadUrl(snapshot.target);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(heartbeat);
      detach();
      listeners.clear();
      await creating?.catch(() => {
      });
      if (ready) await api("close").catch(() => {
      });
    }
  };
  function detach() {
    stream?.close();
    stream = void 0;
    observer?.disconnect();
    densityQuery?.removeEventListener("change", densityListener);
    densityQuery = void 0;
    clearTimeout(resizeTimer);
    clearTimeout(feedbackTimer);
    if (frameRequest) cancelAnimationFrame(frameRequest);
    root?.remove();
    root = void 0;
    image = void 0;
    input = void 0;
    host = void 0;
  }
  const presentation = { mount(viewportId) {
    detach();
    host = document.getElementById(viewportId);
    if (!host) throw new Error("\u6D4F\u89C8\u5668\u89C6\u56FE\u5C1A\u672A\u6302\u8F7D\u3002");
    root = document.createElement("div");
    root.className = "kode-browser-surface";
    root.tabIndex = 0;
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "\u4FA7\u680F\u7F51\u9875\uFF0C\u70B9\u51FB\u540E\u53EF\u8F93\u5165\uFF1BEsc \u8FD4\u56DE\u5730\u5740\u680F");
    Object.assign(root.style, { position: "relative", width: "100%", height: "100%", overflow: "hidden", outline: "none", background: "var(--dsw-alias-bg-base)", touchAction: "none" });
    image = document.createElement("img");
    image.alt = "\u7F51\u9875\u753B\u9762";
    image.draggable = false;
    Object.assign(image.style, { display: "block", width: "100%", height: "100%", objectFit: "contain", userSelect: "none" });
    root.append(image);
    input = document.createElement("textarea");
    input.setAttribute("aria-label", "\u7F51\u9875\u952E\u76D8\u8F93\u5165");
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    Object.assign(input.style, { position: "absolute", width: "1px", height: "1px", left: "0", top: "0", opacity: "0" });
    root.append(input);
    feedback = document.createElement("div");
    feedback.setAttribute("role", "status");
    feedback.hidden = true;
    Object.assign(feedback.style, { position: "absolute", bottom: "12px", left: "12px", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", padding: "6px 10px", borderRadius: "6px", fontSize: "12px", pointerEvents: "none" });
    root.append(feedback);
    host.append(root);
    root.addEventListener("pointerdown", (event) => {
      root.setPointerCapture?.(event.pointerId);
      if (event.pointerType === "touch") {
        event.preventDefault();
        touch = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
        return;
      }
      pointer(event, "mousePressed");
    });
    root.addEventListener("pointermove", (event) => {
      if (touch?.id === event.pointerId) {
        event.preventDefault();
        touch.moved ||= Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 6;
        if (touch.moved) void command("pointer", { type: "mouseWheel", ...coordinates(event), button: "none", deltaX: touch.lastX - event.clientX, deltaY: touch.lastY - event.clientY });
        touch.lastX = event.clientX;
        touch.lastY = event.clientY;
        return;
      }
      pointer(event, "mouseMoved");
    });
    root.addEventListener("pointerup", (event) => {
      if (touch?.id === event.pointerId) {
        event.preventDefault();
        if (!touch.moved) {
          input?.focus({ preventScroll: true });
          const point = coordinates(event);
          void command("pointer", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
          void command("pointer", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
        }
        touch = void 0;
      } else pointer(event, "mouseReleased");
      root.releasePointerCapture?.(event.pointerId);
    });
    root.addEventListener("pointercancel", (event) => {
      touch = void 0;
      pointer(event, "mouseReleased");
    });
    root.addEventListener("wheel", (event) => pointer(event, "mouseWheel"), { passive: false });
    root.addEventListener("contextmenu", (event) => event.preventDefault());
    const key = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" || (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        host?.parentElement?.querySelector("input")?.focus();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "keydown") void copySelection();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void command("key", { type: event.type === "keydown" ? "keyDown" : "keyUp", key: event.key, code: event.code, keyCode: event.keyCode, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0), ...event.type === "keydown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey ? { text: event.key } : {} });
    };
    root.addEventListener("keydown", key);
    root.addEventListener("keyup", key);
    root.addEventListener("compositionstart", () => {
      composing = true;
    });
    root.addEventListener("input", (event) => {
      if (event.target !== input || composing || event.isComposing || !input.value) return;
      const text = input.value;
      input.value = "";
      void command("text", { text });
    });
    root.addEventListener("beforeinput", (event) => {
      if (composing || event.isComposing) return;
      const key2 = event.inputType?.startsWith("delete") ? "Backspace" : event.inputType === "insertLineBreak" || event.inputType === "insertParagraph" ? "Enter" : void 0;
      if (key2) {
        event.preventDefault();
        const keyCode = key2 === "Enter" ? 13 : 8;
        void command("key", { type: "keyDown", key: key2, code: key2, keyCode });
        void command("key", { type: "keyUp", key: key2, code: key2, keyCode });
      }
    });
    root.addEventListener("compositionend", (event) => {
      composing = false;
      if (event.data) void command("text", { text: event.data });
      if (input) input.value = "";
    });
    root.addEventListener("copy", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copySelection();
    });
    root.addEventListener("paste", (event) => {
      event.preventDefault();
      void command("text", { text: event.clipboardData?.getData("text/plain") ?? "" });
    });
    const measure = () => {
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const next = { width: Math.max(320, Math.min(3840, Math.round(bounds.width))), height: Math.max(240, Math.min(2160, Math.round(bounds.height))), pixelRatio: Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1)) };
      if (next.width === size.width && next.height === size.height && next.pixelRatio === size.pixelRatio) return;
      size = next;
      if (ready) void command("resize", size);
    };
    const watchDensity = () => {
      densityQuery?.removeEventListener("change", densityListener);
      densityQuery = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
      densityListener = () => {
        measure();
        watchDensity();
      };
      densityQuery?.addEventListener("change", densityListener);
    };
    measure();
    watchDensity();
    observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(measure, 100);
    });
    observer.observe(root);
    if (ready) {
      void api("heartbeat").then(connect).catch((error) => error.code === "BROWSER_TAB_GONE" ? recoverPage() : failure(error));
    } else connect();
    return detach;
  } };
  return { frame, presentation };
}

return module.exports; })();
var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		//#region lib/types/client/browser/BrowserFrame.js
		/**
		* Create idle navigation state without a page target.
		* @returns state before any page has been requested.
		*/
		function emptyBrowserFrame() {
			return {
				target: void 0,
				address: "empty",
				loading: false,
				canGoBack: false,
				canGoForward: false,
				error: void 0,
				sandboxEnabled: void 0
			};
		}
		//#endregion
		//#region lib/types/client/browser/BrowserPersistence.js
		/**
		* Read the selected address from a saved navigation record.
		* @param state - saved navigation.
		* @returns its last selected address, if any.
		*/
		function currentBrowserTarget(state) {
			return state === void 0 || state.index < 0 ? void 0 : state.entries[state.index];
		}
		/**
		* Checkpoint an observed address without serializing native history.
		* @param target - current address.
		* @param revision - navigation generation.
		* @returns an address-only checkpoint.
		*/
		function browserAddressCheckpoint(target, revision) {
			return {
				entries: [target],
				index: 0,
				request: {
					target,
					revision
				},
				navigation: {
					status: "known",
					revision
				},
				failure: void 0
			};
		}
		//#endregion
		//#region \0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-sidebar-browser/src/client/view/Browser.module.css.mjs
		const css = ".SB_kFW_root{height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);flex-direction:column;flex:auto;display:flex}.SB_kFW_toolbar{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:5px 6px;display:flex}.SB_kFW_tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:0;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.SB_kFW_tool:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.SB_kFW_tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}.SB_kFW_sandboxOff{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}.SB_kFW_addressBox{flex:auto;min-width:0;position:relative}.SB_kFW_address{box-sizing:border-box;width:100%;height:28px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 34px 0 9px}.SB_kFW_addressGo{visibility:hidden;opacity:0;position:absolute;top:0;right:0}.SB_kFW_addressBox:focus-within .SB_kFW_addressGo{visibility:visible;opacity:1}.SB_kFW_addressUnknown{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}.SB_kFW_addressUnknown:focus{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}.SB_kFW_addressChanged{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);pointer-events:none;background:var(--dsw-alias-bg-layer-2);padding-left:8px;line-height:16px;position:absolute;top:6px;right:8px}.SB_kFW_addressBox:focus-within .SB_kFW_addressChanged{visibility:hidden;opacity:0}.SB_kFW_address:focus{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}.SB_kFW_frame{background:var(--dsw-alias-bg-base);border:0;flex:auto;width:100%;min-height:0;display:flex}.SB_kFW_content{flex:auto;min-width:0;min-height:0;display:flex;position:relative}.SB_kFW_viewport{flex:auto;min-width:0;min-height:0;display:flex}.SB_kFW_placeholder{pointer-events:none;display:flex;position:absolute;inset:0}.SB_kFW_restore{text-align:center;flex-direction:column;align-items:center;gap:10px;padding:24px;display:flex;position:absolute;inset:0;overflow:auto}.SB_kFW_restoreLabel{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);margin:auto 0 0}.SB_kFW_restoreTitle{overflow-wrap:anywhere;max-width:100%;font:var(--dsw-font-xs-13);margin:0;font-weight:500}.SB_kFW_restoreUrl{overflow-wrap:anywhere;max-width:100%;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);margin:0}.SB_kFW_restore>:last-child{flex-shrink:0;margin-bottom:auto}.SB_kFW_webview{-webkit-app-region:no-drag;border:0;flex:auto;width:100%;min-width:0;height:100%;min-height:0;display:flex}html:has([data-dockkit-pointer]) .SB_kFW_webview{pointer-events:none}.SB_kFW_start{min-height:0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);text-align:center;flex:auto;justify-content:center;align-items:center;padding:24px;display:flex}.SB_kFW_failure{color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxxs-11);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);flex:none;padding:6px 12px}.SB_kFW_sandboxWarning{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11);background:var(--dsw-alias-state-warn-tertiary);flex:none;padding:6px 12px}.SB_kFW_limit{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);text-overflow:ellipsis;white-space:nowrap;border-top:.5px solid var(--dsw-alias-border-l3);flex:none;margin:0;padding:4px 10px;overflow:hidden}.SB_kFW_titleIcon{flex:none;margin-right:4px}";
		const tagId = "@kode/dsh-browser/Browser.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@kode/dsh-browser";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var Browser_module_css_default = {
			"address": "SB_kFW_address",
			"addressBox": "SB_kFW_addressBox",
			"addressChanged": "SB_kFW_addressChanged",
			"addressGo": "SB_kFW_addressGo",
			"addressUnknown": "SB_kFW_addressUnknown",
			"content": "SB_kFW_content",
			"failure": "SB_kFW_failure",
			"frame": "SB_kFW_frame",
			"limit": "SB_kFW_limit",
			"placeholder": "SB_kFW_placeholder",
			"restore": "SB_kFW_restore",
			"restoreLabel": "SB_kFW_restoreLabel",
			"restoreTitle": "SB_kFW_restoreTitle",
			"restoreUrl": "SB_kFW_restoreUrl",
			"root": "SB_kFW_root",
			"sandboxOff": "SB_kFW_sandboxOff",
			"sandboxWarning": "SB_kFW_sandboxWarning",
			"start": "SB_kFW_start",
			"titleIcon": "SB_kFW_titleIcon",
			"tool": "SB_kFW_tool",
			"toolbar": "SB_kFW_toolbar",
			"viewport": "SB_kFW_viewport",
			"webview": "SB_kFW_webview"
		};
		//#endregion
		//#region lib/types/client/view/BrowserBody.js
		/** Common browser chrome; a presentation adapter attaches the page inside its content container. */
		const EMPTY_FRAME = emptyBrowserFrame();
		function SandboxPolicyIcon({ sandboxed }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "15",
				height: "15",
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true,
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: _deepseek_ai_dsh_client_ui_primitives.SHIELD_OUTLINE_PATH,
					stroke: "currentColor",
					strokeWidth: _deepseek_ai_dsh_client_ui_primitives.ICON_REGULAR_STROKE,
					strokeLinejoin: "round"
				}), sandboxed ? (0, react_jsx_runtime.jsx)("path", {
					d: "M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z",
					fill: "currentColor"
				}) : (0, react_jsx_runtime.jsx)("path", {
					d: "M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z",
					fill: "currentColor",
					transform: "translate(1.2 0.8)"
				})]
			});
		}
		function useBrowserDraft(url, revision) {
			const [edit, setEdit] = (0, react.useState)();
			return [edit?.revision === revision ? edit.value : url ?? "", (value) => {
				setEdit({
					revision,
					value
				});
			}];
		}
		/** Render provider-neutral navigation state and optional controls. */
		function BrowserBody(props) {
			const { mount, loadUrl, restore, goBack, goForward, reload, setSandbox, useBrowserState, useStore, useTabInfo, t } = props;
			const { tab } = useTabInfo();
			(0, react.useEffect)(() => tab.actions.bindCommands({ refresh: () => {
				reload(tab.id);
			} }), [
				tab.actions,
				tab.id,
				reload
			]);
			const initial = (0, react.useRef)(useStore((state) => state.byTab[tab.id]));
			const initialUrl = (0, react.useRef)(tab.navigation.params?.url);
			const viewportId = (0, react.useId)();
			const [mountEpoch, setMountEpoch] = (0, react.useState)(0);
			const state = useBrowserState(tab.id);
			const frame = state?.frame ?? EMPTY_FRAME;
			const restoreTarget = state === void 0 ? currentBrowserTarget(initial.current) : state.restoreTarget;
			const target = frame.target ?? restoreTarget;
			const [draft, setDraft] = useBrowserDraft(target?.url ?? initialUrl.current, state?.addressRevision ?? 0);
			(0, react.useLayoutEffect)(() => {
				const hide = mount({
					tabId: tab.id,
					signal: tab.signal,
					viewportId,
					applicationOrigin: window.location.origin,
					initial: initial.current,
					initialUrl: initialUrl.current,
					openTab: (url) => {
						tab.actions.openTab("browser", {
							params: { url },
							revealIfOpened: false
						});
					}
				});
				setMountEpoch((value) => value + 1);
				return hide;
			}, [
				mount,
				tab.id,
				tab.signal,
				tab.actions,
				viewportId,
				props.actions
			]);
			const unknown = frame.address === "unknown";
			const externalUrl = unknown ? void 0 : target?.url;
			const sandboxed = frame.sandboxEnabled;
			const failure = state?.addressFailure;
			const error = frame.error;
			const submit = (event) => {
				event.preventDefault();
				loadUrl(tab.id, draft);
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: Browser_module_css_default.root,
				children: [
					(0, react_jsx_runtime.jsxs)("form", {
						className: Browser_module_css_default.toolbar,
						onSubmit: submit,
						children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Browser_module_css_default.tool,
								"aria-label": t("back"),
								title: t("back"),
								disabled: !frame.canGoBack,
								onClick: () => {
									goBack(tab.id);
								},
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutlineRegular, {})
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Browser_module_css_default.tool,
								"aria-label": t("forward"),
								title: t("forward"),
								disabled: !frame.canGoForward,
								onClick: () => {
									goForward(tab.id);
								},
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, {})
							}),
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
								label: t("reload"),
								shortcutKeys: tab.refreshShortcut?.keys,
								side: "bottom",
								delayMs: 500,
								children: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: Browser_module_css_default.tool,
									"aria-label": t("reload"),
									"aria-keyshortcuts": tab.refreshShortcut?.aria,
									disabled: target === void 0 || mountEpoch === 0,
									onClick: () => {
										reload(tab.id);
									},
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, {})
								})
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: Browser_module_css_default.addressBox,
								children: [
									(0, react_jsx_runtime.jsx)("input", {
										className: [Browser_module_css_default.address, unknown ? Browser_module_css_default.addressUnknown : ""].join(" "),
										value: draft,
										"aria-label": t("address.placeholder"),
										placeholder: t("address.placeholder"),
										spellCheck: false,
										onChange: (event) => {
											setDraft(event.currentTarget.value);
										}
									}),
									unknown && (0, react_jsx_runtime.jsx)("span", {
										className: Browser_module_css_default.addressChanged,
										children: t("address.changed")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: [Browser_module_css_default.tool, Browser_module_css_default.addressGo].join(" "),
										"aria-label": t("go"),
										title: t("go"),
										children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutlineRegular, {})
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Browser_module_css_default.tool,
								"aria-label": t("external"),
								title: t("external"),
								disabled: externalUrl === void 0,
								onClick: externalUrl === void 0 ? void 0 : () => {
									window.open(externalUrl, "_blank", "noopener,noreferrer");
								},
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutlineRegular, { size: 14 })
							}),
							sandboxed !== void 0 && (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: [Browser_module_css_default.tool, sandboxed ? "" : Browser_module_css_default.sandboxOff].join(" "),
								"aria-label": t(sandboxed ? "sandbox.disable" : "sandbox.enable"),
								title: t(sandboxed ? "sandbox.disable" : "sandbox.enable"),
								"aria-pressed": !sandboxed,
								onClick: () => {
									setSandbox(tab.id, !sandboxed);
								},
								children: (0, react_jsx_runtime.jsx)(SandboxPolicyIcon, { sandboxed })
							})
						]
					}),
					sandboxed === false && (0, react_jsx_runtime.jsx)("div", {
						className: Browser_module_css_default.sandboxWarning,
						role: "status",
						children: t("sandbox.warning")
					}),
					error !== void 0 && (0, react_jsx_runtime.jsx)("div", {
						className: Browser_module_css_default.failure,
						role: "status",
						children: error.code !== void 0 && error.description !== void 0 ? t("load.failed.detail", {
							code: String(error.code),
							description: error.description
						}) : t("load.failed")
					}),
					failure !== void 0 && (0, react_jsx_runtime.jsx)("div", {
						className: Browser_module_css_default.failure,
						role: "alert",
						children: t(`error.${failure}`)
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: Browser_module_css_default.content,
						"aria-busy": frame.loading,
						children: [
							(0, react_jsx_runtime.jsx)("div", {
								id: viewportId,
								className: Browser_module_css_default.viewport,
								"aria-label": t("type.label")
							}),
							restoreTarget !== void 0 && (0, react_jsx_runtime.jsxs)("section", {
								className: Browser_module_css_default.restore,
								"aria-label": t("restore.previous"),
								children: [
									(0, react_jsx_runtime.jsx)("p", {
										className: Browser_module_css_default.restoreLabel,
										children: t("restore.previous")
									}),
									(0, react_jsx_runtime.jsx)("p", {
										className: Browser_module_css_default.restoreTitle,
										children: restoreTarget.title
									}),
									(0, react_jsx_runtime.jsx)("p", {
										className: Browser_module_css_default.restoreUrl,
										children: restoreTarget.url
									}),
									(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: mountEpoch === 0,
										onClick: () => {
											restore(tab.id);
										},
										children: t("restore.action")
									})
								]
							}),
							restoreTarget === void 0 && (target === void 0 || frame.loading) && error === void 0 && (0, react_jsx_runtime.jsx)("div", {
								className: Browser_module_css_default.placeholder,
								children: (0, react_jsx_runtime.jsx)("div", {
									className: Browser_module_css_default.start,
									children: t(target === void 0 ? "start" : "loading")
								})
							})
						]
					}),
					unknown && (0, react_jsx_runtime.jsx)("p", {
						className: Browser_module_css_default.limit,
						children: t("address.unknown")
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/view/BrowserTitle.js
		/** Browser icon and current host name. */
		function BrowserTitle({ useTabInfo, useStore }) {
			const { tab } = useTabInfo();
			const entry = useStore((state) => currentBrowserTarget(state.byTab[tab.id]));
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular, { className: Browser_module_css_default.titleIcon }), entry?.title ?? tab.title] });
		}
		/**
		* Parse one address-bar value into the fixed protocol allowlist.
		* @param input - user or typed-open input.
		* @param applicationOrigin - current DSH document origin, blocked for HTTPS.
		* @returns a canonical target or the refusal reason.
		*/
		function parseBrowserAddress(input, applicationOrigin) {
			const trimmed = input.trim();
			if (trimmed === "") return {
				ok: false,
				reason: "empty"
			};
			if (trimmed.length > 16384) return {
				ok: false,
				reason: "invalid"
			};
			const candidate = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed) ? trimmed : `https://${trimmed}`;
			let url;
			try {
				url = new URL(candidate);
			} catch {
				return {
					ok: false,
					reason: "invalid"
				};
			}
			if (url.username !== "" || url.password !== "") return {
				ok: false,
				reason: "credentials"
			};
			if (url.protocol === "https:" || url.protocol === "http:") {
				if (applicationOrigin !== void 0 && applicationOrigin !== "null") try {
					if (url.origin === new URL(applicationOrigin).origin) return {
						ok: false,
						reason: "application-origin"
					};
				} catch {}
				return {
					ok: true,
					target: {
						kind: url.protocol === "https:" ? "https" : "http",
						url: url.href,
						title: url.hostname
					}
				};
			}
			return {
				ok: false,
				reason: "protocol"
			};
		}
		//#endregion
		//#region lib/types/client/browser/BrowserController.js
		/** Carrier-independent tab commands and renderer-facing state. */
		/** Owns input validation and page lifetime without inspecting the carrier type. */
		var BrowserController = class {
			options;
			page;
			store;
			unsubscribe;
			actions;
			checkpoint;
			started = false;
			disposed = false;
			disposal;
			abort = () => {
				this.dispose();
			};
			/** @param options - identity, persistence, page factory and source-tab navigation. */
			constructor(options) {
				this.options = options;
				this.actions = options.actions;
				this.checkpoint = options.initial;
				this.page = options.createPage({
					initial: options.initial,
					persist: (state) => {
						if (this.disposed) return;
						this.checkpoint = state;
						this.actions.replace(options.tabId, state);
					},
					openRequested: (value) => {
						if (this.disposed) return;
						const result = parseBrowserAddress(value, options.applicationOrigin);
						if (!result.ok) {
							this.addressFailed(result.reason);
							return;
						}
						options.openTab(result.target.url);
					}
				});
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
					frame: this.page.frame.getSnapshot(),
					restoreTarget: currentBrowserTarget(this.checkpoint),
					addressFailure: void 0,
					addressRevision: 0
				});
				this.unsubscribe = this.page.frame.subscribe(() => {
					if (this.disposed) return;
					const current = this.store.getSnapshot();
					const frame = this.page.frame.getSnapshot();
					const changed = frame.target?.url !== current.frame.target?.url;
					this.store.set({
						frame,
						restoreTarget: frame.target === void 0 ? currentBrowserTarget(this.checkpoint) : void 0,
						addressFailure: changed ? void 0 : current.addressFailure,
						addressRevision: current.addressRevision + Number(changed)
					});
				});
				options.signal.addEventListener("abort", this.abort, { once: true });
			}
			/** @returns immutable state for the common toolbar. */
			getSnapshot = () => this.store.getSnapshot();
			/** @param listener - state invalidation. @returns unsubscribe callback. */
			subscribe = (listener) => this.store.subscribe(listener);
			/**
			* Attach the page without transferring ownership of its tab occurrence.
			* @param viewportId - mounted content container.
			* @returns physical attachment cleanup only.
			*/
			mount(viewportId) {
				this.publishSaved();
				return this.page.presentation.mount(viewportId);
			}
			/**
			* Consume initial navigation once; a saved checkpoint alone never starts a page.
			* @param initialUrl - explicit typed-open address, or absence.
			*/
			start(initialUrl) {
				if (this.started || this.disposed) return;
				this.started = true;
				if (initialUrl !== void 0) this.loadUrl(initialUrl);
			}
			/** Load the saved address only after an explicit restore action. */
			restore() {
				const target = this.store.getSnapshot().restoreTarget;
				if (target !== void 0) this.loadUrl(target.url);
			}
			/**
			* Validate an address before navigation, publishing invalid input for correction.
			* @param value - address-bar or typed-open input.
			*/
			loadUrl(value) {
				if (this.disposed) return;
				const parsed = parseBrowserAddress(value, this.options.applicationOrigin);
				if (!parsed.ok) {
					this.addressFailed(parsed.reason);
					return;
				}
				this.command(() => {
					this.page.frame.loadUrl(parsed.target);
				});
			}
			/** Delegate Back to the page's navigation provider. */
			goBack() {
				this.command(() => {
					this.page.frame.goBack();
				});
			}
			/** Delegate Forward to the page's navigation provider. */
			goForward() {
				this.command(() => {
					this.page.frame.goForward();
				});
			}
			/** Restore a saved address, or reload the already requested page. */
			reload() {
				if (this.store.getSnapshot().restoreTarget !== void 0) this.restore();
				else this.command(() => {
					this.page.frame.reload();
				});
			}
			/**
			* Apply the optional embedding-sandbox control; unsupported providers remain unchanged.
			* @param enabled - whether to enforce the provider's embedding sandbox.
			*/
			setSandbox(enabled) {
				const sandbox = this.page.frame.sandbox;
				if (sandbox !== void 0) this.command(() => {
					sandbox.setEnabled(enabled);
				});
			}
			/**
			* Redirect future checkpoint writes to a replacement Session binding.
			* @param actions - replacement persistence writer.
			*/
			rebind(actions) {
				this.actions = actions;
			}
			/**
			* Release the page and detach occurrence and state listeners.
			* @returns after page teardown; repeated callers join the same disposal.
			*/
			dispose() {
				if (this.disposal !== void 0) return this.disposal;
				this.disposed = true;
				this.options.signal.removeEventListener("abort", this.abort);
				this.unsubscribe();
				this.disposal = this.page.frame.dispose();
				return this.disposal;
			}
			publishSaved() {
				if (this.checkpoint !== void 0) this.actions.replace(this.options.tabId, this.checkpoint);
			}
			addressFailed(reason) {
				this.store.set({
					...this.store.getSnapshot(),
					addressFailure: reason
				});
			}
			command(run) {
				if (this.disposed) return;
				const current = this.store.getSnapshot();
				this.store.set({
					...current,
					addressFailure: void 0,
					addressRevision: current.addressRevision + 1
				});
				run();
			}
		};
		/**
		* Own tab-occurrence controllers behind Session-scoped callbacks.
		* @param actions - persisted view-state writer.
		* @param createPage - composition-selected provider.
		* @param isTabOpen - authoritative layout membership, independent of mounted bodies and plugin lifetime.
		* @returns tab callbacks.
		*/
		function createBrowserControllers(actions, createPage, isTabOpen) {
			let currentActions = actions;
			const controllers = /* @__PURE__ */ new Map();
			const controller = (id) => controllers.get(id)?.controller;
			return {
				keyedHooks: { browserState: (key) => controller(key) },
				mount(request) {
					const { tabId, signal } = request;
					if (signal.aborted) return () => {};
					let held = controllers.get(tabId);
					if (held?.signal !== signal) {
						if (held !== void 0) {
							held.signal.removeEventListener("abort", held.forget);
							held.controller.dispose();
						}
						const created = new BrowserController({
							...request,
							actions: currentActions,
							createPage
						});
						const forget = () => {
							controllers.delete(tabId);
							if (!isTabOpen(tabId)) currentActions.forget(tabId);
						};
						held = {
							signal,
							controller: created,
							forget
						};
						controllers.set(tabId, held);
						signal.addEventListener("abort", forget, { once: true });
					}
					const hide = held.controller.mount(request.viewportId);
					held.controller.start(request.initialUrl);
					return hide;
				},
				dispose: async () => {
					const pending = [...controllers.values()].map(({ signal, controller, forget }) => {
						signal.removeEventListener("abort", forget);
						return controller.dispose();
					});
					controllers.clear();
					await Promise.all(pending);
				},
				rebind: (actions) => {
					currentActions = actions;
					for (const { controller } of controllers.values()) controller.rebind(actions);
				},
				loadUrl: (id, value) => {
					controller(id)?.loadUrl(value);
				},
				restore: (id) => {
					controller(id)?.restore();
				},
				goBack: (id) => {
					controller(id)?.goBack();
				},
				goForward: (id) => {
					controller(id)?.goForward();
				},
				reload: (id) => {
					controller(id)?.reload();
				},
				setSandbox: (id, enabled) => {
					controller(id)?.setSandbox(enabled);
				}
			};
		}
		/**
		* Owns the application-known URL history and the iframe observation state machine.
		* The first load for a request keeps its URL authoritative; another load marks it unknown.
		*/
		var BrowserNavigation = class BrowserNavigation {
			value;
			/**
			* @param initial - persisted state restored for this tab, or a fresh empty state.
			*/
			constructor(initial = BrowserNavigation.empty()) {
				this.value = initial;
			}
			/**
			* Create state before a tab has a controlled navigation target.
			* @returns empty serializable state.
			*/
			static empty() {
				return {
					entries: [],
					index: -1,
					request: void 0,
					navigation: { status: "empty" },
					failure: void 0
				};
			}
			/**
			* Read the selected application-history entry.
			* @param state - serializable tab state.
			* @returns the current target, if any.
			*/
			static current(state) {
				return state === void 0 || state.index < 0 ? void 0 : state.entries[state.index];
			}
			/**
			* Test whether the Web carrier can use the preceding application-history entry.
			* @param state - serializable tab state.
			* @returns whether Back is available.
			*/
			static canGoBack(state) {
				return state.navigation.status !== "unknown" && state.index > 0;
			}
			/**
			* Test whether the Web carrier can use the following application-history entry.
			* @param state - serializable tab state.
			* @returns whether Forward is available.
			*/
			static canGoForward(state) {
				return state.navigation.status !== "unknown" && state.index >= 0 && state.index < state.entries.length - 1;
			}
			/** Current immutable serializable state. */
			get snapshot() {
				return this.value;
			}
			/** Whether the Web iframe can safely use the application-owned Back entry. */
			get canGoBack() {
				return BrowserNavigation.canGoBack(this.value);
			}
			/** Whether the Web iframe can safely use the application-owned Forward entry. */
			get canGoForward() {
				return BrowserNavigation.canGoForward(this.value);
			}
			/**
			* Add a controlled target and discard its stale forward branch.
			* @param target - validated canonical target.
			* @returns the new load request.
			*/
			navigate(target) {
				const entries = [...this.value.entries.slice(0, this.value.index + 1), target];
				if (entries.length > 100) entries.splice(0, entries.length - 100);
				return this.request(target, {
					...this.value,
					entries,
					index: entries.length - 1
				});
			}
			/**
			* Select the preceding application-known target.
			* @returns a new load request, or undefined when unavailable.
			*/
			back() {
				if (!this.canGoBack) return void 0;
				const index = this.value.index - 1;
				const target = this.value.entries[index];
				return this.request(target, {
					...this.value,
					index
				});
			}
			/**
			* Select the following application-known target.
			* @returns a new load request, or undefined when unavailable.
			*/
			forward() {
				if (!this.canGoForward) return void 0;
				const index = this.value.index + 1;
				const target = this.value.entries[index];
				return this.request(target, {
					...this.value,
					index
				});
			}
			/**
			* Start another load of the last application-known target.
			* @returns a new load request, or undefined before the first target.
			*/
			reload() {
				const target = BrowserNavigation.current(this.value);
				return target === void 0 ? void 0 : this.request(target, this.value);
			}
			/**
			* Record a frame load for its captured revision.
			* @param revision - revision bound to the rendered frame.
			*/
			frameLoaded(revision) {
				const navigation = this.value.navigation;
				if (navigation.status === "empty" || navigation.revision !== revision) return;
				if (navigation.status === "loading") this.value = {
					...this.value,
					navigation: {
						status: "known",
						revision
					}
				};
				else if (navigation.status === "known") this.value = {
					...this.value,
					navigation: {
						status: "unknown",
						revision
					}
				};
			}
			request(target, basis) {
				const request = {
					revision: (this.value.request?.revision ?? 0) + 1,
					target
				};
				this.value = {
					...basis,
					request,
					navigation: {
						status: "loading",
						revision: request.revision
					},
					failure: void 0
				};
				return request;
			}
		};
		//#endregion
		//#region lib/types/client/browser/IframeImpl.js
		/** Iframe navigation provider with bounded application-known history. */
		/** Owns iframe navigation; the view reports loads without reading cross-origin content. */
		var IframeImpl = class {
			options;
			presentation;
			sandbox = { setEnabled: (enabled) => {
				this.setSandbox(enabled);
			} };
			navigation;
			store;
			sandboxed = true;
			error;
			disposed = false;
			disposal;
			/** @param options - initial checkpoint and persistence writer. @param presentation - iframe DOM adapter. */
			constructor(options, presentation) {
				this.options = options;
				this.presentation = presentation;
				this.navigation = new BrowserNavigation(options.initial);
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
					...emptyBrowserFrame(),
					sandboxEnabled: this.sandboxed
				});
			}
			/**
			* Record a controlled load or a later navigation to an unreadable address.
			* @param revision - document generation whose iframe emitted load.
			*/
			handleLoaded(revision) {
				if (this.disposed) return;
				this.navigation.frameLoaded(revision);
				this.publish();
			}
			/**
			* Publish a failure only for the current document generation.
			* @param revision - document generation whose iframe reported failure.
			*/
			handleLoadFailed(revision) {
				if (this.disposed || this.navigation.snapshot.request?.revision !== revision) return;
				this.error = {
					code: void 0,
					description: void 0
				};
				this.publish();
			}
			/** @returns immutable navigation state. */
			getSnapshot = () => this.store.getSnapshot();
			/** @param listener - state invalidation. @returns unsubscribe callback. */
			subscribe = (listener) => this.store.subscribe(listener);
			/** @param target - validated address; submitting the current address reloads it. */
			loadUrl(target) {
				if (this.disposed) return;
				const request = BrowserNavigation.current(this.navigation.snapshot)?.url === target.url ? this.navigation.reload() : this.navigation.navigate(target);
				this.load(request);
			}
			/** Move through application-known history while the iframe address remains known. */
			goBack() {
				if (!this.disposed) this.load(this.navigation.back());
			}
			/** Move through application-known history while the iframe address remains known. */
			goForward() {
				if (!this.disposed) this.load(this.navigation.forward());
			}
			/** Reload the last application-known address. */
			reload() {
				if (!this.disposed) this.load(this.navigation.reload());
			}
			/** @returns after the presentation has been removed; repeated calls join disposal. */
			dispose() {
				if (this.disposal !== void 0) return this.disposal;
				this.disposed = true;
				this.presentation.dispose();
				this.disposal = Promise.resolve();
				return this.disposal;
			}
			setSandbox(enabled) {
				if (this.disposed || enabled === this.sandboxed) return;
				this.sandboxed = enabled;
				if (this.store.getSnapshot().target === void 0) {
					this.store.set({
						...this.store.getSnapshot(),
						sandboxEnabled: enabled
					});
					return;
				}
				this.load(this.navigation.reload());
			}
			load(request) {
				if (request === void 0) return;
				this.error = void 0;
				this.publish();
				this.presentation.show({
					target: request.target,
					revision: request.revision,
					sandboxed: this.sandboxed
				});
			}
			snapshot() {
				const state = this.navigation.snapshot;
				const target = BrowserNavigation.current(state);
				return {
					target,
					address: target === void 0 ? "empty" : state.navigation.status === "unknown" ? "unknown" : "requested",
					loading: state.navigation.status === "loading" && this.error === void 0,
					canGoBack: this.navigation.canGoBack,
					canGoForward: this.navigation.canGoForward,
					error: this.error,
					sandboxEnabled: this.sandboxed
				};
			}
			publish() {
				this.store.set(this.snapshot());
				this.options.persist(this.navigation.snapshot);
			}
		};
		//#endregion
		//#region lib/types/client/view/IframePresentation.js
		/** Fixed iframe policy; top navigation and downloads are not granted directly. */
		const WEB_BROWSER_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox";
		/** Owns the iframe element; navigation and history remain in IframeImpl. */
		var IframePresentation = class {
			events;
			host;
			element;
			document;
			rendered = false;
			/** @param events - provider-owned load and remount callbacks. */
			constructor(events) {
				this.events = events;
			}
			/** @param viewportId - mounted placeholder. @returns removes only the iframe presentation. */
			mount(viewportId) {
				const host = document.getElementById(viewportId);
				if (host === null) throw new Error("iframe presentation: viewport is not mounted");
				this.element?.remove();
				this.element = void 0;
				this.host = host;
				if (this.rendered) this.events.remounted();
				else this.render();
				return () => {
					if (this.host !== host) return;
					this.element?.remove();
					this.element = void 0;
					this.host = void 0;
				};
			}
			/**
			* Retain the prepared document and render it when a container is mounted.
			* @param value - prepared document and event generation.
			*/
			show(value) {
				this.document = value;
				this.render();
			}
			/** Remove the owned DOM and retained presentation data. */
			dispose() {
				this.element?.remove();
				this.element = void 0;
				this.host = void 0;
				this.document = void 0;
			}
			render() {
				const current = this.document;
				const host = this.host;
				if (current === void 0 || host === void 0) return;
				this.element?.remove();
				const element = document.createElement("iframe");
				element.className = Browser_module_css_default.frame;
				element.src = current.target.url;
				element.title = current.target.title;
				element.referrerPolicy = "no-referrer";
				element.dataset.sidebarBrowserFrame = "iframe";
				if (current.sandboxed) element.setAttribute("sandbox", WEB_BROWSER_SANDBOX);
				element.addEventListener("load", () => {
					if (this.element === element) this.events.loaded(current.revision);
				});
				element.addEventListener("error", () => {
					if (this.element === element) this.events.failed(current.revision);
				});
				this.element = element;
				this.rendered = true;
				host.append(element);
			}
		};
		//#endregion
		//#region lib/types/client/pages.js
		/**
		* Assemble an idle iframe provider and its DOM presentation.
		* @param options - saved navigation and callbacks.
		* @returns the Web page's navigation and presentation objects.
		*/
		function createIframePage(options) {
			const presentation = new IframePresentation({
				loaded: (revision) => {
					frame.handleLoaded(revision);
				},
				failed: (revision) => {
					frame.handleLoadFailed(revision);
				},
				remounted: () => {
					frame.reload();
				}
			});
			const frame = new IframeImpl(options, presentation);
			return {
				frame,
				presentation
			};
		}
		//#endregion
		//#region lib/types/client/electron/ElectronWebViewImpl.js
		/** Electron navigation and guest lifetime, independent from DOM placement. */
		/** Owns native history and translates Electron observations into common frame state. */
		var ElectronWebViewImpl = class {
			options;
			bridge;
			workspace;
			presentation;
			store;
			lifetime = new AbortController();
			guestLifetime;
			element;
			lease;
			workspaceKey;
			initializing;
			ready = false;
			pending;
			revision = 0;
			firstDocument = true;
			checkpoint;
			disposal;
			attachment;
			releases = /* @__PURE__ */ new Set();
			/**
			* @param options - saved address, persistence and source-tab opening callback.
			* @param bridge - main-process guest operations.
			* @param workspace - resolves the storage account once for this frame lifetime.
			* @param presentation - tag and Sidebar placement adapter.
			*/
			constructor(options, bridge, workspace, presentation) {
				this.options = options;
				this.bridge = bridge;
				this.workspace = workspace;
				this.presentation = presentation;
				this.checkpoint = currentBrowserTarget(options.initial);
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(emptyBrowserFrame());
			}
			/** @returns immutable carrier-neutral navigation state. */
			getSnapshot = () => this.store.getSnapshot();
			/** @param listener - state invalidation. @returns unsubscribe callback. */
			subscribe = (listener) => this.store.subscribe(listener);
			/** A physical mount may recreate a lost guest; ordinary Sidebar hiding never calls this. */
			attach() {
				if (this.lifetime.signal.aborted) return;
				this.attachment = new AbortController();
				this.pending ??= this.store.getSnapshot().target;
				if (this.pending !== void 0) {
					this.store.set({
						...this.store.getSnapshot(),
						address: "requested",
						loading: true,
						canGoBack: false,
						canGoForward: false,
						error: void 0
					});
					this.initialize();
				}
			}
			/** Invalidate pending attachment before the containing DOM is removed. */
			detach() {
				this.attachment?.abort();
				this.attachment = void 0;
				this.pending = this.store.getSnapshot().target;
				this.dropGuest();
			}
			/** @param target - validated address, loaded without replacing the guest. */
			loadUrl(target) {
				if (this.lifetime.signal.aborted) return;
				const current = this.store.getSnapshot();
				if (this.ready && current.address === "observed" && current.target?.url === target.url) {
					this.reload();
					return;
				}
				this.revision++;
				this.pending = target;
				this.store.set({
					...current,
					target,
					address: "requested",
					loading: true,
					error: void 0
				});
				this.persist(target);
				if (this.ready) this.loadPending();
				else this.initialize();
			}
			/** Move backward through Chromium history. */
			goBack() {
				if (this.store.getSnapshot().canGoBack) this.navigate("goBack");
			}
			/** Move forward through Chromium history. */
			goForward() {
				if (this.store.getSnapshot().canGoForward) this.navigate("goForward");
			}
			/** Reload the actual current page, or retry failed guest creation. */
			reload() {
				const current = this.store.getSnapshot();
				if (this.lifetime.signal.aborted || current.target === void 0) return;
				if (!this.ready || current.error !== void 0) {
					this.revision++;
					this.pending = current.target;
					this.store.set({
						...current,
						loading: true,
						error: void 0
					});
					if (this.ready) this.loadPending();
					else this.initialize();
				} else this.navigate("reload");
			}
			/** @returns after pending initialization and the owned guest have been released. */
			dispose() {
				if (this.disposal !== void 0) return this.disposal;
				this.lifetime.abort();
				this.pending = void 0;
				this.disposal = Promise.all([this.dropGuest(), this.initializing]).then(() => Promise.all(this.releases)).then(() => {});
				this.presentation.dispose();
				return this.disposal;
			}
			navigate(command) {
				if (this.lifetime.signal.aborted || !this.ready || this.element === void 0) return;
				this.revision++;
				this.pending = void 0;
				this.store.set({
					...this.store.getSnapshot(),
					loading: true,
					error: void 0
				});
				try {
					this.element[command]();
				} catch (error) {
					this.commandFailed(error);
				}
			}
			initialize() {
				const attachment = this.attachment;
				if (attachment === void 0 || this.initializing !== void 0 || this.element !== void 0 || this.lifetime.signal.aborted) return;
				const signal = AbortSignal.any([this.lifetime.signal, attachment.signal]);
				this.initializing = this.createGuest(signal).catch(async (error) => {
					await this.dropGuest();
					if (!signal.aborted) this.commandFailed(error);
				}).finally(() => {
					this.initializing = void 0;
					if (this.attachment !== attachment && this.pending !== void 0) this.initialize();
				});
			}
			async createGuest(attachmentSignal) {
				this.workspaceKey ??= await this.workspace(attachmentSignal);
				if (attachmentSignal.aborted) return;
				const reservation = await this.bridge.acquire(this.workspaceKey);
				if (attachmentSignal.aborted) {
					await this.release(reservation.lease);
					return;
				}
				this.lease = reservation.lease;
				this.guestLifetime = new AbortController();
				const signal = AbortSignal.any([attachmentSignal, this.guestLifetime.signal]);
				const element = this.presentation.createElement(reservation);
				this.element = element;
				const unsubscribeOpen = this.bridge.onOpenRequested(reservation.lease, (url) => {
					if (this.element === element && !signal.aborted) this.options.openRequested(url);
				});
				signal.addEventListener("abort", unsubscribeOpen, { once: true });
				element.addEventListener("dom-ready", () => {
					this.ready = true;
					this.observe(this.store.getSnapshot().address !== "requested");
					this.loadPending();
				}, { signal });
				element.addEventListener("did-navigate", () => {
					this.observe(true);
				}, { signal });
				element.addEventListener("did-navigate-in-page", (event) => {
					if (event.isMainFrame) this.observe(true);
				}, { signal });
				element.addEventListener("did-start-navigation", (event) => {
					if (event.isMainFrame) this.store.set({
						...this.store.getSnapshot(),
						loading: true,
						error: void 0
					});
				}, { signal });
				for (const name of [
					"did-start-loading",
					"did-stop-loading",
					"page-title-updated"
				]) element.addEventListener(name, () => {
					this.observe(name === "page-title-updated" && this.store.getSnapshot().address === "observed");
				}, { signal });
				element.addEventListener("did-fail-load", (event) => {
					const failure = event;
					if (failure.isMainFrame && failure.errorCode !== -3) this.failed({
						code: failure.errorCode,
						description: failure.errorDescription
					});
				}, { signal });
				for (const name of ["render-process-gone", "destroyed"]) element.addEventListener(name, () => {
					this.dropGuest();
					this.failed();
				}, { signal });
				this.presentation.present(element);
			}
			loadPending() {
				const target = this.pending;
				const element = this.element;
				if (!this.ready || target === void 0 || element === void 0) return;
				const revision = this.revision;
				this.pending = void 0;
				element.loadURL(target.url).catch((error) => {
					if (this.element !== element || this.lifetime.signal.aborted || this.revision !== revision) return;
					if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_ABORTED") return;
					if (this.store.getSnapshot().error === void 0) this.commandFailed(error);
				});
			}
			observe(committed) {
				if (!this.ready || this.element === void 0 || this.lifetime.signal.aborted) return;
				try {
					this.observeReady(this.element, committed);
				} catch (error) {
					this.commandFailed(error);
				}
			}
			observeReady(element, committed) {
				const current = this.store.getSnapshot();
				const parsed = committed ? parseBrowserAddress(element.getURL()) : void 0;
				if (parsed?.ok && this.firstDocument) {
					element.clearHistory();
					this.firstDocument = false;
				}
				let target = current.target;
				let address = current.address;
				if (parsed?.ok) {
					target = {
						...parsed.target,
						title: element.getTitle() || parsed.target.title
					};
					address = "observed";
					this.presentation.show(target.title);
				}
				const loading = current.error === void 0 && element.isLoading();
				const canGoBack = element.canGoBack();
				const canGoForward = element.canGoForward();
				if (target?.url !== current.target?.url || target?.title !== current.target?.title || address !== current.address || loading !== current.loading || canGoBack !== current.canGoBack || canGoForward !== current.canGoForward) this.store.set({
					...current,
					target,
					address,
					loading,
					canGoBack,
					canGoForward
				});
				if (parsed?.ok && target !== void 0) this.persist(target);
			}
			persist(target) {
				if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return;
				this.checkpoint = target;
				this.options.persist(browserAddressCheckpoint(target, this.revision));
			}
			failed(error = {
				code: void 0,
				description: void 0
			}) {
				if (this.lifetime.signal.aborted) return;
				const current = this.store.getSnapshot();
				this.store.set({
					...current,
					loading: false,
					error,
					canGoBack: this.ready && current.canGoBack,
					canGoForward: this.ready && current.canGoForward
				});
			}
			commandFailed(error) {
				console.error("Desktop browser operation failed", error);
				this.failed();
			}
			dropGuest() {
				this.guestLifetime?.abort();
				this.guestLifetime = void 0;
				this.presentation.clear();
				this.element = void 0;
				this.ready = false;
				this.firstDocument = true;
				const lease = this.lease;
				this.lease = void 0;
				return lease === void 0 ? Promise.resolve() : this.release(lease);
			}
			release(lease) {
				const released = this.bridge.release(lease).catch((error) => {
					console.error("Desktop browser guest release failed", error);
				}).finally(() => {
					this.releases.delete(released);
				});
				this.releases.add(released);
				return released;
			}
		};
		//#endregion
		//#region lib/types/client/electron/ElectronWebviewPresentation.js
		/** Owns tag creation and attachment, without measuring or following another element. */
		var ElectronWebviewPresentation = class {
			events;
			element;
			host;
			constructor(events) {
				this.events = events;
			}
			/** @param viewportId - committed content container. @returns ends attachment and releases its guest. */
			mount(viewportId) {
				const host = document.getElementById(viewportId);
				if (host === null) throw new Error("Electron presentation: content container is not mounted");
				if (this.host !== void 0) this.events.unmounted();
				this.host = host;
				this.events.mounted();
				return () => {
					if (this.host !== host) return;
					this.events.unmounted();
					this.host = void 0;
				};
			}
			/**
			* Configure a detached webview for an approved guest reservation.
			* @param reservation - main-approved partition and bootstrap lease.
			* @returns a detached, configured webview.
			*/
			createElement(reservation) {
				const element = document.createElement("webview");
				element.className = Browser_module_css_default.webview;
				element.dataset.sidebarBrowserFrame = "webview";
				element.setAttribute("name", reservation.lease);
				element.setAttribute("partition", reservation.partition);
				element.setAttribute("allowpopups", "");
				element.setAttribute("src", "about:blank#" + reservation.lease);
				return element;
			}
			/**
			* Attach a prepared guest, removing any previous guest DOM from the container.
			* @param element - configured guest with its navigation listeners already installed.
			* @throws when no content container is mounted.
			*/
			present(element) {
				if (this.host === void 0) throw new Error("Electron presentation: cannot attach without a content container");
				this.clear();
				this.element = element;
				this.host.append(element);
			}
			/**
			* Set the guest element's accessible label.
			* @param title - observed document title.
			*/
			show(title) {
				this.element?.setAttribute("aria-label", title);
			}
			/** Destroy only the guest DOM; a replacement may use the same mounted container. */
			clear() {
				this.element?.remove();
				this.element = void 0;
			}
			/** Destroy the guest DOM and release its content container. */
			dispose() {
				this.clear();
				this.host = void 0;
			}
		};
		//#endregion
		//#region lib/types/client/electron/pages.js
		/**
		* Assemble an idle Electron provider; guest creation waits for mounting and navigation.
		* @param options - checkpoint and source-tab callbacks.
		* @param bridge - desktop-only transport.
		* @param workspace - storage account resolver.
		* @returns separate navigation and presentation faces.
		*/
		function createElectronPage(options, bridge, workspace) {
			const presentation = new ElectronWebviewPresentation({
				mounted: () => {
					frame.attach();
				},
				unmounted: () => {
					frame.detach();
				}
			});
			const frame = new ElectronWebViewImpl(options, bridge, workspace, presentation);
			return {
				frame,
				presentation
			};
		}
		//#endregion
		//#region lib/types/client/electron/workspace.js
		/**
		* Use the Workspace's canonical CWD, not its record id; ungrouped Sessions remain isolated.
		* @param source - authoritative Workspace membership.
		* @param sessionId - owning DSH Session.
		* @param signal - guest initialization lifetime.
		* @returns the storage account for this occurrence.
		*/
		async function browserWorkspace(source, sessionId, signal) {
			signal.throwIfAborted();
			if (source.getSnapshot().phase !== "ready") await new Promise((resolve, reject) => {
				const abort = () => {
					stop();
					const reason = signal.reason;
					reject(reason);
				};
				const stop = source.subscribe(() => {
					if (source.getSnapshot().phase !== "ready") return;
					stop();
					signal.removeEventListener("abort", abort);
					resolve();
				});
				signal.addEventListener("abort", abort, { once: true });
			});
			signal.throwIfAborted();
			const workspace = source.getSnapshot().items.find((item) => item.sessionIds.some((id) => id === sessionId));
			return workspace === void 0 ? `session:${sessionId}` : `cwd:${workspace.path}`;
		}
		//#endregion
		//#region lib/types/client/definition.js
		/** Browser tab kind. */
		const BROWSER_KIND = "browser";
		/** Browser implementation identity and keyed Slot dispatch key. */
		const BROWSER_ID = "@kode/dsh-browser";
		/** Build the Browser type with locale-live copy. */
		function browserDefinition(t) {
			return {
				id: BROWSER_ID,
				kind: BROWSER_KIND,
				multiple: true,
				priority: "builtin",
				title: () => t("type.label"),
				guide: [{
					id: "new",
					commandId: "browser.new",
					order: 30,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: _deepseek_ai_dsh_client_ui_primitives.GuideArtworkBrowser
				}]
			};
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** Locale-owned Browser tab copy. */
		const zh = {
			"type.label": "浏览器",
			"guide.title": "浏览器",
			"guide.description": "浏览网页",
			"shortcut.noSession": "请先打开一个会话",
			"address.placeholder": "输入 HTTP(S) 地址",
			"address.changed": "URL 已变化",
			back: "后退",
			forward: "前进",
			reload: "刷新",
			go: "前往",
			external: "在系统浏览器中打开",
			"sandbox.disable": "关闭沙箱限制",
			"sandbox.enable": "恢复沙箱限制",
			"sandbox.warning": "沙箱限制已关闭；页面可以导航顶层应用，并使用下载、模态对话框与输入锁定。",
			start: "输入 HTTP(S) 地址开始浏览",
			loading: "正在打开…",
			"restore.previous": "上次打开",
			"restore.action": "恢复页面",
			"error.empty": "请输入地址。",
			"error.invalid": "这个地址无效或过长。",
			"error.protocol": "只支持 HTTP 和 HTTPS 地址；本地文件请使用文档预览。",
			"error.credentials": "地址不能包含用户名或密码。",
			"error.application-origin": "不能在嵌入浏览器中打开 DSH 应用自身。",
			"load.failed": "页面加载失败；请刷新重试或在系统浏览器中打开。",
			"load.failed.detail": "页面加载失败 ({code}): {description}",
			"address.unknown": "页面已跳转；当前载体无法读取新的 URL。"
		};
		/** English dictionary with the same keys. */
		const en = {
			"type.label": "Browser",
			"guide.title": "Browser",
			"guide.description": "Browse web pages",
			"shortcut.noSession": "Open a session first",
			"address.placeholder": "Enter an HTTP(S) address",
			"address.changed": "URL changed",
			back: "Back",
			forward: "Forward",
			reload: "Reload",
			go: "Go",
			external: "Open in system browser",
			"sandbox.disable": "Disable sandbox restrictions",
			"sandbox.enable": "Restore sandbox restrictions",
			"sandbox.warning": "Sandbox restrictions are disabled; the page can navigate the top-level app and use downloads, modal dialogs, and input locks.",
			start: "Enter an HTTP(S) address to start browsing",
			loading: "Opening…",
			"restore.previous": "Previously opened",
			"restore.action": "Restore page",
			"error.empty": "Enter an address.",
			"error.invalid": "That address is invalid or too long.",
			"error.protocol": "Only HTTP and HTTPS addresses are supported; use Document Preview for local files.",
			"error.credentials": "Addresses cannot contain a username or password.",
			"error.application-origin": "The embedded browser cannot open the DSH application itself.",
			"load.failed": "The page could not load; reload or open it in the system browser.",
			"load.failed.detail": "Page load failed ({code}): {description}",
			"address.unknown": "The page navigated; this carrier cannot read its new URL."
		};
		//#endregion
		//#region lib/types/client/browser/store.js
		/** Persisted Browser tab snapshots shared by the body and title slots. */
		/**
		* Declare the Session-scoped Browser persistence store.
		* @returns a fresh store handle for Slot registration.
		*/
		function createBrowserStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ byTab: {} }),
				persist: "dsh.sidebar-browser.v1",
				actions: {
					replace: (draft, tabId, state) => {
						draft.byTab[tabId] = state;
					},
					forget: (draft, tabId) => {
						const byTab = {};
						for (const [id, state] of Object.entries(draft.byTab)) if (id !== tabId) byTab[id] = state;
						draft.byTab = byTab;
					}
				}
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required Browser services. */
		const inject = [
			"slots",
			"locale",
			"sidebarRight",
			"sidebarRightTabs"
		];
		/** Register the Browser type, localized guide entry, body, and title. */
		function apply(ctx) {
			const namespace = "sidebarBrowser";
			const t = ctx.locale.bind(namespace);
			ctx.inject(["shortcuts"], (ctx) => {
				ctx.effect(() => ctx.shortcuts.register({
					id: "browser.new",
					label: () => t("guide.title"),
					aliases: ["browser", "new browser tab"],
					defaults: {
						"desktop:macos": {
							code: "KeyT",
							modifiers: ["primary"]
						},
						"desktop:windows": {
							code: "KeyT",
							modifiers: ["primary"]
						},
						"desktop:linux": {
							code: "KeyT",
							modifiers: ["primary"]
						},
						"web:macos": {
							code: "KeyT",
							modifiers: ["primary", "alt"]
						},
						"web:windows": {
							code: "KeyT",
							modifiers: ["primary", "alt"]
						}
					},
					regions: [
						"page",
						"editable",
						"terminal"
					],
					modals: [],
					resolve: ({ target: element }) => {
						const target = ctx.sidebarRight.commandTarget(element);
						if (target === void 0) return {
							status: "blocked",
							reason: t("shortcut.noSession")
						};
						return {
							status: "handled",
							run: () => {
								ctx.sidebarRight.openTabFromTarget("browser", target);
							}
						};
					}
				}), "ui-sidebar-browser: shortcut");
			});
			const store = createBrowserStore();
			const openTabs = ctx.sidebarRight.openTabs;
			const carrier = globalThis.dshDesktop;
			const desktop = carrier?.protocolVersion === 1 ? carrier.browser : void 0;
			ctx.effect(() => ctx.locale.register(namespace, {
				zh,
				en
			}), "ui-sidebar-browser.copy");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				...browserDefinition(t),
				keepMounted: desktop !== void 0
			}), "ui-sidebar-browser.type");
			const installFrames = (scope, factory) => {
				const controllers = /* @__PURE__ */ new Map();
				scope.effect(() => async () => {
					const pending = [...controllers.values()].map((controller) => controller.dispose());
					controllers.clear();
					await Promise.all(pending);
				}, "ui-sidebar-browser.frames");
				scope.effect(() => scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({
					name: "sidebar.right.pane.tab",
					key: BROWSER_ID,
					locale: namespace,
					store,
					inject: (sessionId, actions) => {
						const existing = controllers.get(sessionId);
						if (existing !== void 0) {
							existing.rebind(actions);
							return existing;
						}
						const controller = createBrowserControllers(actions, factory(sessionId), (tabId) => openTabs.getSnapshot().some((tab) => tab.sessionId === sessionId && tab.tabId === tabId));
						controllers.set(sessionId, controller);
						return controller;
					}
				}, BrowserBody)), "ui-sidebar-browser.body");
			};
			if (desktop === void 0) installFrames(ctx, () => kodeBrowserPage.createBrowserPage);
			else ctx.inject(["workspaces"], (scope) => {
				installFrames(scope, (sessionId) => (options) => createElectronPage(options, desktop, (signal) => browserWorkspace(scope.workspaces.list, sessionId, signal)));
			});
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: BROWSER_ID,
				store
			}, BrowserTitle)), "ui-sidebar-browser.title");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map