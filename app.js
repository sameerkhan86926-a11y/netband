(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ==========================================
  // NETBAND CONFIGURATION
  // Enter your Supabase details here.
  // Never use a secret/service_role key.
  // ==========================================

  const config = {
    url: "https://frjzfmskbkcogeeqytjm.supabase.co",
    key: "sb_publishable_CIl_axgZv5JixyEKj_-d5A_xypfty-U"
  };

  // ==========================================
  // APPLICATION STATE
  // ==========================================

  const state = {
    client: null,
    room: null,
    channel: null,
    timer: null,
    expiresAt: null,
    seen: new Set(),
    senderId: getSenderId(),
    busy: false
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

    if (state.room) {
      if (!online) {
        $("chatStatus").textContent =
          "Offline • messages cannot reach other devices";
      } else if (!state.channel) {
        $("chatStatus").textContent =
          "Internet available • reconnecting";
      }
    }
  }

  window.addEventListener("online", setNetwork);
  window.addEventListener("offline", setNetwork);

  setNetwork();

  // ==========================================
  // SUPABASE CONNECTION
  // ==========================================

  function backendReady() {
    if (
      !window.supabase ||
      !window.supabase.createClient
    ) {
      throw new Error(
        "Chat service could not load. Check your internet connection and refresh."
      );
    }

    if (
      !config.url.startsWith("https://") ||
      config.url.includes("PASTE_YOUR_") ||
      !config.key ||
      config.key.includes("PASTE_YOUR_")
    ) {
      throw new Error(
        "NETBAND configuration is incomplete. The site owner needs to add the Supabase Project URL and Publishable Key in app.js."
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
  // ROOM CODE GENERATOR
  // ==========================================

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    const bytes = crypto.getRandomValues(
      new Uint8Array(8)
    );

    return Array.from(
      bytes,
      byte => chars[byte % chars.length]
    ).join("");
  }

  // ==========================================
  // ERROR DISPLAY
  // ==========================================

  function showError(id, message) {
    const element = $(id);

    if (element) {
      element.textContent = message || "";
    }
  }

  // ==========================================
  // SAFE MESSAGE RENDERING
  // ==========================================

  function renderMessage(message) {
    if (!message || state.seen.has(message.id)) {
      return;
    }

    state.seen.add(message.id);

    const container = $("chatMessages");

    const empty = container.querySelector(".empty-state");

    if (empty) {
      empty.remove();
    }

    const div = document.createElement("div");

    div.className =
      "message" +
      (
        message.sender_id === state.senderId
          ? " mine"
          : ""
      );

    const sender = document.createElement("div");

    sender.className = "sender";

    sender.textContent =
      message.sender_id === state.senderId
        ? "YOU"
        : "ROOM MEMBER";

    const body = document.createElement("div");

    body.className = "body";

    // textContent prevents messages from being interpreted as HTML.
    body.textContent = String(message.body || "");

    const time = document.createElement("time");

    const date = new Date(
      message.created_at || Date.now()
    );

    time.textContent = date.toLocaleTimeString(
      [],
      {
        hour: "2-digit",
        minute: "2-digit"
      }
    );

    div.appendChild(sender);
    div.appendChild(body);
    div.appendChild(time);

    container.appendChild(div);

    container.scrollTop = container.scrollHeight;
  }

  // ==========================================
  // SHOW CHAT ROOM
  // ==========================================

  function showChat(room) {
    state.room = room;

    state.expiresAt = new Date(
      room.expires_at
    ).getTime();

    $("setupPanel").classList.add("hidden");

    $("chatPanel").classList.remove("hidden");

    $("roomCodeDisplay").textContent = room.code;

    $("chatTitle").textContent = "Temporary room";

    $("chatMessages").innerHTML = `
      <div class="empty-state">
        <span>✧</span>
        <strong>Your conversation starts here</strong>
        <p>Share the room code with the person you want to chat with.</p>
      </div>
    `;

    state.seen.clear();

    startTimer();

    $("chatStatus").textContent = "Connecting…";
  }

  // ==========================================
  // ROOM EXPIRY TIMER
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

      const minutes = Math.floor(
        remaining / 60000
      );

      const seconds = Math.floor(
        (remaining % 60000) / 1000
      );

      $("expiryTitle").textContent =
        remaining > 0
          ? `Room expires in ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
          : "Room expired";

      $("expiryBar").style.width =
        `${Math.max(0, remaining / 1800000 * 100)}%`;

      if (remaining <= 0) {
        clearInterval(state.timer);

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
    if (state.busy) {
      return;
    }

    state.busy = true;

    showError("setupError", "");
    showError("chatError", "");

    $("createBtn").disabled = true;

    try {
      const client = backendReady();

      let room;

      if (createNew) {
        // Create a room.
        // Database should set expires_at automatically.
        const { data, error } = await client
          .from("rooms")
          .insert({
            code: generateRoomCode()
          })
          .select(
            "id,code,created_at,expires_at"
          )
          .single();

        if (error) {
          throw error;
        }

        room = data;

      } else {
        // Join an existing room.
        const normalizedCode = roomCode
          .trim()
          .toUpperCase();

        if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalizedCode)) {
          throw new Error(
            "Enter a valid 8-character room code."
          );
        }

        const { data, error } = await client
          .from("rooms")
          .select(
            "id,code,created_at,expires_at"
          )
          .eq("code", normalizedCode)
          .gt(
            "expires_at",
            new Date().toISOString()
          )
          .maybeSingle();

        if (error) {
          throw error;
        }

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
        throw new Error(
          "This room has expired. Create a new room."
        );
      }

      showChat(room);

      // Load previous messages.
      const {
        data: oldMessages,
        error: fetchError
      } = await client
        .from("messages")
        .select(
          "id,room_id,sender_id,body,created_at"
        )
        .eq("room_id", room.id)
        .order("created_at", {
          ascending: true
        })
        .limit(200);

      if (fetchError) {
        throw fetchError;
      }

      (oldMessages || []).forEach(renderMessage);

      // Remove previous subscription if one exists.
      if (state.channel) {
        await client.removeChannel(state.channel);
        state.channel = null;
      }

      // Subscribe to realtime messages.
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
              payload.new &&
              payload.new.room_id === room.id
            ) {
              renderMessage(payload.new);
            }
          }
        )
        .subscribe(status => {
          if (status === "SUBSCRIBED") {
            $("chatStatus").textContent =
              "Connected • realtime active";
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
          "Could not connect. Check the Supabase configuration and SQL policies."
      );

      if (state.room) {
        $("chatPanel").classList.add("hidden");
        $("setupPanel").classList.remove("hidden");

        state.room = null;
      }

    } finally {
      state.busy = false;
      $("createBtn").disabled = false;
    }
  }

  // ==========================================
  // CREATE ROOM BUTTON
  // ==========================================

  $("createBtn").addEventListener(
    "click",
    () => connectRoom("", true)
  );

  // ==========================================
  // JOIN ROOM FORM
  // ==========================================

  $("joinForm").addEventListener(
    "submit",
    event => {
      event.preventDefault();

      connectRoom(
        $("roomInput").value,
        false
      );
    }
  );

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

      if (!body || !state.room) {
        return;
      }

      if (!navigator.onLine) {
        showError(
          "chatError",
          "You are offline. This message has not been sent."
        );

        return;
      }

      if (Date.now() >= state.expiresAt) {
        showError(
          "chatError",
          "This room has expired."
        );

        return;
      }

      const sendButton = document.querySelector(
        "#messageForm button[type='submit']"
      );

      sendButton.disabled = true;

      try {
        const client = backendReady();

        const { error } = await client
          .from("messages")
          .insert({
            room_id: state.room.id,
            sender_id: state.senderId,
            body
          });

        if (error) {
          throw error;
        }

        input.value = "";

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

  $("copyCodeBtn").addEventListener(
    "click",
    async () => {
      if (!state.room) {
        return;
      }

      const code = state.room.code;

      try {
        await navigator.clipboard.writeText(code);

        $("copyCodeBtn").textContent = "Copied!";

        setTimeout(() => {
          $("copyCodeBtn").textContent = "Copy";
        }, 1500);

      } catch {
        prompt(
          "Copy this room code:",
          code
        );
      }
    }
  );

  // ==========================================
  // LEAVE ROOM
  // ==========================================

  async function leaveRoom(expired = false) {
    clearInterval(state.timer);

    state.timer = null;

    if (state.channel && state.client) {
      try {
        await state.client.removeChannel(
          state.channel
        );
      } catch (error) {
        console.error(
          "Could not close realtime channel:",
          error
        );
      }
    }

    state.channel = null;
    state.room = null;
    state.expiresAt = null;

    $("chatPanel").classList.add("hidden");

    $("setupPanel").classList.remove("hidden");

    $("roomInput").value = "";

    $("chatMessages").innerHTML = `
      <div class="empty-state">
        <span>✧</span>
        <strong>Your conversation starts here</strong>
        <p>Share the room code with the person you want to chat with.</p>
      </div>
    `;

    if (expired) {
      showError(
        "setupError",
        "Room expired. Create a new room to chat."
      );
    }
  }

  $("leaveBtn").addEventListener(
    "click",
    () => leaveRoom(false)
  );

  // ==========================================
  // SERVICE WORKER
  // ==========================================

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(error => {
          console.warn(
            "Service worker registration failed:",
            error
          );
        });
    });
  }

})();
