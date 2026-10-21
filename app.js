(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ==========================================
  // SUPABASE CONFIGURATION
  // Replace both placeholders with your actual values.
  // Never use a secret/service_role key.
  // ==========================================

  const config = {
    url: "https://frjzfmskbkcogeeqytjm.supabase.co",
    key: "sb_publishable_CIl_axgZv5JixyEKj_-d5A_xypfty-U"
  };

  const MESSAGE_PREFIX = "__NETBAND_V2__:";

  const state = {
    client: null,
    room: null,
    channel: null,
    timer: null,
    expiresAt: null,
    seen: new Set(),
    senderId: getSenderId(),
    busy: false,
    replyTarget: null,
    joining: false
  };

  // ==========================================
  // SESSION ID
  // ==========================================

  function getSenderId() {
    try {
      let id = sessionStorage.getItem("netband_sender_id");

      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem("netband_sender_id", id);
      }

      return id;
    } catch {
      return crypto.randomUUID();
    }
  }

  // ==========================================
  // NETWORK STATUS
  // ==========================================

  function setNetwork() {
    const online = navigator.onLine;

    $("networkLabel").textContent =
      online ? "Internet available" : "Offline";

    $("onlineDot").classList.toggle("online", online);

    if (!state.room) return;

    if (!online) {
      $("chatStatus").textContent =
        "Offline · messages cannot be sent";
    } else if (!state.channel) {
      $("chatStatus").textContent =
        "Internet available · reconnecting";
    }
  }

  window.addEventListener("online", setNetwork);
  window.addEventListener("offline", setNetwork);

  setNetwork();

  // ==========================================
  // SUPABASE CLIENT
  // ==========================================

  function backendReady() {
    if (!window.supabase?.createClient) {
      throw new Error(
        "Chat service could not load. Check your internet connection and refresh."
      );
    }

    if (
      !config.url.startsWith("https://") ||
      config.url === "SUPABASE_PROJECT_URL" ||
      !config.key ||
      config.key === "SUPABASE_PUBLISHABLE_KEY"
    ) {
      throw new Error(
        "Add your Supabase Project URL and publishable key in app.js."
      );
    }

    if (!state.client) {
      state.client = window.supabase.createClient(
        config.url,
        config.key
      );
    }

    return state.client;
  }

  // ==========================================
  // ROOM CODE
  // ==========================================

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(8));

    return Array.from(
      bytes,
      byte => chars[byte % chars.length]
    ).join("");
  }

  // ==========================================
  // ERROR HANDLING
  // ==========================================

  function showError(id, message) {
    const element = $(id);

    if (element) {
      element.textContent = message || "";
    }
  }

  // ==========================================
  // MESSAGE ENCODING
  // ==========================================

  function encodeMessageBody(text, replyTo) {
    if (!replyTo) return text;

    return MESSAGE_PREFIX + JSON.stringify({
      text,
      replyTo: {
        id: replyTo.id,
        text: String(replyTo.text || "").slice(0, 300)
      }
    });
  }

  function parseMessageBody(rawBody) {
    const text = String(rawBody || "");

    if (text.startsWith(MESSAGE_PREFIX)) {
      try {
        const parsed = JSON.parse(
          text.slice(MESSAGE_PREFIX.length)
        );

        if (parsed && typeof parsed.text === "string") {
          return {
            text: parsed.text,
            replyTo: parsed.replyTo || null
          };
        }
      } catch {
        // Treat malformed metadata as ordinary text below.
      }
    }

    return {
      text,
      replyTo: null
    };
  }

  // ==========================================
  // EMPTY STATE
  // ==========================================

  function showEmptyState() {
    const container = $("chatMessages");

    if (container.querySelector(".message")) return;

    container.replaceChildren();

    const empty = document.createElement("div");
    empty.className = "empty-state";

    const icon = document.createElement("span");
    icon.textContent = "✧";

    const title = document.createElement("strong");
    title.textContent = "Your conversation starts here";

    const description = document.createElement("p");
    description.textContent =
      "Share the room code with the person you want to chat with.";

    empty.append(icon, title, description);
    container.appendChild(empty);
  }

  // ==========================================
  // COPY TEXT
  // ==========================================

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement("textarea");

      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";

      document.body.appendChild(textarea);
      textarea.select();

      let copied = false;

      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }

      textarea.remove();

      if (!copied) {
        window.prompt("Copy this text:", text);
      }

      return copied;
    }
  }

  // ==========================================
  // REPLY PREVIEW
  // ==========================================

  function setReplyTarget(message, text) {
    state.replyTarget = {
      id: message.id,
      text: String(text || "").slice(0, 300)
    };

    $("replyPreviewText").textContent =
      state.replyTarget.text;

    $("replyComposerPreview").classList.remove("hidden");

    $("messageInput").focus();
  }

  function clearReplyTarget() {
    state.replyTarget = null;

    $("replyComposerPreview").classList.add("hidden");
    $("replyPreviewText").textContent = "";
  }

  $("cancelReplyBtn").addEventListener(
    "click",
    clearReplyTarget
  );

  // ==========================================
  // RENDER MESSAGE
  // ==========================================

  function renderMessage(message) {
    if (!message || state.seen.has(message.id)) {
      return;
    }

    state.seen.add(message.id);

    const container = $("chatMessages");
    const empty = container.querySelector(".empty-state");

    if (empty) empty.remove();

    const parsed = parseMessageBody(message.body);

    const div = document.createElement("article");

    div.className =
      "message" +
      (
        message.sender_id === state.senderId
          ? " mine"
          : ""
      );

    div.dataset.messageId = String(message.id);

    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent =
      message.sender_id === state.senderId
        ? "YOU"
        : "ROOM MEMBER";

    div.appendChild(sender);

    if (parsed.replyTo) {
      const quote = document.createElement("div");
      quote.className = "reply-preview";

      const quoteLabel = document.createElement("strong");
      quoteLabel.textContent = "↩ Replying to";

      const quoteText = document.createElement("span");
      quoteText.textContent = parsed.replyTo.text || "Message";

      quote.append(quoteLabel, quoteText);
      div.appendChild(quote);
    }

    const body = document.createElement("div");
    body.className = "body";
    body.textContent = parsed.text;

    div.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "message-actions";

    const time = document.createElement("time");

    const date = new Date(
      message.created_at || Date.now()
    );

    time.dateTime = date.toISOString();

    time.textContent = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });

    const actions = document.createElement("div");
    actions.className = "message-buttons";

    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "message-action";
    replyBtn.textContent = "↩ Reply";

    replyBtn.addEventListener("click", () => {
      setReplyTarget(message, parsed.text);
    });

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "message-action";
    copyBtn.textContent = "Copy";

    copyBtn.addEventListener("click", async () => {
      const originalText = parsed.text;

      await copyText(originalText);

      copyBtn.textContent = "Copied!";

      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1200);
    });

    actions.append(replyBtn, copyBtn);
    footer.append(time, actions);
    div.appendChild(footer);

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ==========================================
  // SHOW ROOM
  // ==========================================

  function showChat(room) {
    state.room = room;
    state.expiresAt = new Date(room.expires_at).getTime();

    $("setupPanel").classList.add("hidden");
    $("chatPanel").classList.remove("hidden");

    $("roomCodeDisplay").textContent = room.code;
    $("chatTitle").textContent = "Temporary room";

    $("chatMessages").replaceChildren();
    state.seen.clear();
    clearReplyTarget();
    showEmptyState();

    $("chatStatus").textContent = "Connecting…";

    startTimer();
  }

  // ==========================================
  // ROOM TIMER
  // ==========================================

  function startTimer() {
    clearInterval(state.timer);

    const tick = async () => {
      if (!state.room || !state.expiresAt) {
        clearInterval(state.timer);
        return;
      }

      const remaining = Math.max(
        0,
        state.expiresAt - Date.now()
      );

      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);

      $("expiryTitle").textContent =
        remaining > 0
          ? `Room expires in ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
          : "Room expired";

      $("expiryBar").style.width =
        `${Math.min(100, remaining / 1800000 * 100)}%`;

      if (remaining <= 0) {
        await leaveRoom(true);

        alert(
          "This room has expired. Create a new room to continue."
        );
      }
    };

    tick();
    state.timer = setInterval(tick, 1000);
  }

  // ==========================================
  // CREATE OR JOIN ROOM
  // ==========================================

  async function connectRoom(roomCode, createNew) {
    if (state.busy) return;

    state.busy = true;

    showError("setupError", "");
    showError("chatError", "");

    $("createBtn").disabled = true;

    try {
      const client = backendReady();
      let room;

      if (createNew) {
        const { data, error } = await client
          .from("rooms")
          .insert({
            code: generateRoomCode()
          })
          .select("id,code,created_at,expires_at")
          .single();

        if (error) throw error;

        room = data;
      } else {
        const normalizedCode = roomCode.trim().toUpperCase();

        if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalizedCode)) {
          throw new Error(
            "Enter a valid 8-character room code."
          );
        }

        const { data, error } = await client
          .from("rooms")
          .select("id,code,created_at,expires_at")
          .eq("code", normalizedCode)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();

        if (error) throw error;

        if (!data) {
          throw new Error(
            "Room not found or expired. Check the code and try again."
          );
        }

        room = data;
      }

      if (
        !room ||
        !room.expires_at ||
        new Date(room.expires_at).getTime() <= Date.now()
      ) {
        throw new Error("This room has expired.");
      }

      // Close previous channel before switching rooms.
      if (state.channel) {
        await client.removeChannel(state.channel);
        state.channel = null;
      }

      showChat(room);

      const { data: oldMessages, error: fetchError } = await client
        .from("messages")
        .select("id,room_id,sender_id,body,created_at")
        .eq("room_id", room.id)
        .order("created_at", { ascending: true })
        .limit(200);

      if (fetchError) throw fetchError;

      (oldMessages || []).forEach(renderMessage);

      state.channel = client
        .channel("room-" + room.id)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: "room_id=eq." + room.id
          },
          payload => {
            if (
              state.room &&
              payload.new &&
              payload.new.room_id === state.room.id
            ) {
              renderMessage(payload.new);
            }
          }
        )
        .subscribe(status => {
          if (status === "SUBSCRIBED") {
            $("chatStatus").textContent =
              "Connected · realtime active";
          } else if (status === "CHANNEL_ERROR") {
            $("chatStatus").textContent =
              "Realtime connection error";
          } else if (status === "TIMED_OUT") {
            $("chatStatus").textContent =
              "Connection timed out";
          } else {
            $("chatStatus").textContent =
              "Connection: " + status.toLowerCase();
          }
        });

      setNetwork();

    } catch (error) {
      showError(
        "setupError",
        error.message ||
          "Could not connect. Check your Supabase settings and permissions."
      );

      if (state.room) {
        clearInterval(state.timer);
        state.room = null;
        state.expiresAt = null;

        $("chatPanel").classList.add("hidden");
        $("setupPanel").classList.remove("hidden");
      }
    } finally {
      state.busy = false;
      $("createBtn").disabled = false;
    }
  }

  // ==========================================
  // CREATE ROOM
  // ==========================================

  $("createBtn").addEventListener("click", () => {
    connectRoom("", true);
  });

  // ==========================================
  // JOIN ROOM
  // ==========================================

  $("joinForm").addEventListener("submit", event => {
    event.preventDefault();

    connectRoom($("roomInput").value, false);
  });

  // ==========================================
  // SEND MESSAGE
  // ==========================================

  $("messageForm").addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      showError("chatError", "");

      const input = $("messageInput");
      const body = input.value.trim();

      if (!body || !state.room) return;

      if (!navigator.onLine) {
        showError(
          "chatError",
          "You are offline. This message has not been sent."
        );
        return;
      }

      if (Date.now() >= state.expiresAt) {
        showError("chatError", "This room has expired.");
        return;
      }

      const sendButton = $("sendBtn");
      sendButton.disabled = true;

      try {
        const client = backendReady();

        const messageBody = encodeMessageBody(
          body,
          state.replyTarget
        );

        const { error } = await client
          .from("messages")
          .insert({
            room_id: state.room.id,
            sender_id: state.senderId,
            body: messageBody
          });

        if (error) throw error;

        input.value = "";
        clearReplyTarget();

      } catch (error) {
        showError(
          "chatError",
          "Message not sent: " +
            (error.message || "Check your connection.")
        );
      } finally {
        sendButton.disabled = false;
        input.focus();
      }
    }
  );

  // ==========================================
  // COPY ROOM CODE
  // ==========================================

  $("copyCodeBtn").addEventListener("click", async () => {
    if (!state.room) return;

    await copyText(state.room.code);

    const button = $("copyCodeBtn");
    button.textContent = "Copied!";

    setTimeout(() => {
      button.textContent = "Copy code";
    }, 1200);
  });

  // ==========================================
  // LEAVE ROOM
  // ==========================================

  async function leaveRoom(expired = false) {
    clearInterval(state.timer);
    state.timer = null;

    if (state.channel && state.client) {
      try {
        await state.client.removeChannel(state.channel);
      } catch (error) {
        console.warn("Could not close realtime channel.");
      }
    }

    state.channel = null;
    state.room = null;
    state.expiresAt = null;

    clearReplyTarget();

    $("chatPanel").classList.add("hidden");
    $("setupPanel").classList.remove("hidden");
    $("roomInput").value = "";

    $("chatMessages").replaceChildren();
    state.seen.clear();
    showEmptyState();

    if (expired) {
      showError(
        "setupError",
        "Room expired. Create a new room to chat."
      );
    }
  }

  $("leaveBtn").addEventListener("click", () => {
    leaveRoom(false);
  });

  // ==========================================
  // SERVICE WORKER
  // ==========================================

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(error => {
          console.warn("Service worker registration failed.");
        });
    });
  }
})();
