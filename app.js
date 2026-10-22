(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const CONFIG = {
    SUPABASE_URL: "https://frjzfmskbkcogeeqytjm.supabase.co",
    SUPABASE_KEY: "sb_publishable_CIl_axgZv5JixyEKj_-d5A_xypfty-U",
    LIVEKIT_URL: "wss://netband-oxhvo3gt.livekit.cloud",
    TOKEN_FUNCTION: "smooth-handler",
    ROOM_DURATION: 30 * 60 * 1000,
    MAX_MESSAGE_LENGTH: 2000
  };

  const supabaseLibrary = window.supabase;
  const livekitLibrary = window.LivekitClient;

  const state = {
    client: null,
    channel: null,
    room: null,
    roomCode: null,
    expiresAt: null,
    timer: null,
    senderId: getSenderId(),
    senderName: getSenderName(),
    seen: new Set(),
    replyTarget: null,
    messages: new Map(),
    reactions: new Map(), // messageId -> Map(emoji -> Set(senderIds))
    call: null,
    callConnecting: false,
    busy: false,
    searchTerm: "",
    localTracks: [],
    soundEnabled: true,
    notificationsEnabled: false,
    isScreenSharing: false,
    typingTimer: null,
    activeBurnerTtl: 0, // 0 = off, else seconds
    activeReactionTargetId: null,
    // Voice Recorder State
    mediaRecorder: null,
    audioChunks: [],
    recordStartTime: 0,
    recordTimerInterval: null,
    isRecordingVoice: false
  };

  /* Native Soft Tone Synthesizer */
  function playNotificationSound() {
    if (!state.soundEnabled) return;
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(587.33, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);

      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.25);
    } catch {}
  }

  function triggerDesktopNotification(senderName, text) {
    if (!state.notificationsEnabled || document.visibilityState === "visible") return;
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`NETBAND · ${senderName}`, {
        body: text.slice(0, 100),
        icon: "./apple-touch-icon.png"
      });
    }
  }

  function getSenderId() {
    let id = sessionStorage.getItem("netband_sender_id");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("netband_sender_id", id);
    }
    return id;
  }

  function getSenderName() {
    let name = sessionStorage.getItem("netband_name");
    if (!name) {
      name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
      sessionStorage.setItem("netband_name", name);
    }
    return name;
  }

  function initializeBackend() {
    if (!supabaseLibrary?.createClient) throw new Error("Supabase SDK not loaded.");
    if (!state.client) {
      state.client = supabaseLibrary.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
    }
    return state.client;
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function showError(id, message = "") {
    setText(id, message);
  }

  function setBusy(value) {
    state.busy = value;
    if ($("createBtn")) $("createBtn").disabled = value;
    if ($("roomInput")) $("roomInput").disabled = value;
    const btn = $("joinForm")?.querySelector('button[type="submit"]');
    if (btn) btn.disabled = value;
  }

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join("");
  }

  function formatTime(val) {
    return new Date(val).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatDuration(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(min).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
  }

  function decodeMessageBody(body) {
    const prefix = "__NETBAND_V2__:";
    if (typeof body !== "string" || !body.startsWith(prefix)) {
      return { text: body || "", replyTo: null, media: null, burnerTtl: 0 };
    }
    try {
      const data = JSON.parse(body.slice(prefix.length));
      return {
        text: data.text || "",
        replyTo: data.replyTo || null,
        media: data.media || null,
        burnerTtl: Number(data.burnerTtl || 0)
      };
    } catch {
      return { text: body, replyTo: null, media: null, burnerTtl: 0 };
    }
  }

  function encodeMessageBody(text, replyTo = null, media = null, burnerTtl = 0) {
    return "__NETBAND_V2__:" + JSON.stringify({ text, replyTo, media, burnerTtl });
  }

  function setNetworkStatus() {
    const online = navigator.onLine;
    setText("networkLabel", online ? "Online" : "Offline");
    const dot = $("onlineDot");
    if (dot) {
      dot.style.background = online ? "var(--success)" : "var(--danger)";
    }
  }

  function showChat(room) {
    state.room = room;
    state.roomCode = room.code;
    state.expiresAt = new Date(room.expires_at).getTime();

    document.querySelector(".wa-app-window")?.classList.add("in-chat");
    $("emptyPlaceholder")?.classList.add("hidden");
    $("activeChatWrapper")?.classList.remove("hidden");

    setText("chatTitle", `Room #${room.code.slice(0, 4)}`);
    setText("roomCodeDisplay", room.code);

    const shareUrl = new URL(location.href);
    shareUrl.searchParams.set("room", room.code);
    history.replaceState({}, "", shareUrl);

    startExpiryTimer();
  }

  function startExpiryTimer() {
    clearInterval(state.timer);
    function update() {
      const remaining = state.expiresAt - Date.now();
      if (remaining <= 0) {
        clearInterval(state.timer);
        leaveRoom();
        showError("setupError", "Room expired. Create a new one.");
        return;
      }
      setText("expiryTitle", formatDuration(remaining));
    }
    update();
    state.timer = setInterval(update, 1000);
  }

  async function createRoom() {
    if (state.busy) return;
    setBusy(true);
    showError("setupError");

    try {
      const client = initializeBackend();
      let createdRoom = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        const code = generateRoomCode();
        const { data, error } = await client
          .from("rooms")
          .insert({ code, expires_at: new Date(Date.now() + CONFIG.ROOM_DURATION).toISOString() })
          .select("id,code,created_at,expires_at")
          .single();

        if (!error) { createdRoom = data; break; }
        if (!String(error.message || "").toLowerCase().includes("duplicate")) throw error;
      }

      if (!createdRoom) throw new Error("Could not initialize room.");
      await connectToRoom(createdRoom);
    } catch (err) {
      showError("setupError", err.message || "Room creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(code) {
    if (state.busy) return;
    const roomCode = String(code || "").trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(roomCode)) {
      showError("setupError", "Please input a valid 8-char code.");
      return;
    }

    setBusy(true);
    showError("setupError");

    try {
      const client = initializeBackend();
      const { data, error } = await client
        .from("rooms")
        .select("id,code,created_at,expires_at")
        .eq("code", roomCode)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error("Room expired or not found.");
      await connectToRoom(data);
    } catch (err) {
      showError("setupError", err.message || "Room join failed.");
    } finally {
      setBusy(false);
    }
  }

  async function connectToRoom(room) {
    await disconnectRealtime();
    state.room = room;
    state.roomCode = room.code;
    state.seen.clear();
    state.messages.clear();
    state.reactions.clear();

    showChat(room);
    setText("chatStatus", "Connecting…");

    try {
      const client = initializeBackend();
      const { data, error } = await client
        .from("messages")
        .select("id,room_id,sender_id,body,created_at,edited_at,deleted_at")
        .eq("room_id", room.id)
        .order("created_at", { ascending: true })
        .limit(300);

      if (error) throw error;
      (data || []).forEach(m => renderMessage(m, false));

      state.channel = client
        .channel(`netband-room-${room.id}`, { config: { broadcast: { self: false } } })
        .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `room_id=eq.${room.id}` }, payload => {
          if (payload.eventType === "INSERT") renderMessage(payload.new, true);
          else if (payload.eventType === "UPDATE") updateMessage(payload.new);
          else if (payload.eventType === "DELETE") removeMessage(payload.old.id);
        })
        .on("broadcast", { event: "typing" }, payload => {
          if (payload.payload?.senderId !== state.senderId) {
            handleTypingIndicator(payload.payload?.senderName);
          }
        })
        .on("broadcast", { event: "reaction" }, payload => {
          handleIncomingReaction(payload.payload);
        })
        .subscribe(status => {
          if (status === "SUBSCRIBED") setText("chatStatus", "online");
        });
    } catch (err) {
      setText("chatStatus", "error");
    }
  }

  async function disconnectRealtime() {
    if (state.channel && state.client) await state.client.removeChannel(state.channel);
    state.channel = null;
  }

  function handleTypingIndicator(name) {
    const indicator = $("typingIndicator");
    if (!indicator) return;
    setText("typingText", `${name || "Guest"} is typing…`);
    indicator.classList.remove("hidden");

    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      indicator.classList.add("hidden");
    }, 2000);
  }

  let lastTypingBroadcast = 0;
  function emitTyping() {
    toggleSendVoiceButtons();
    if (!state.channel || !state.room) return;
    const now = Date.now();
    if (now - lastTypingBroadcast < 1000) return;
    lastTypingBroadcast = now;

    state.channel.send({
      type: "broadcast",
      event: "typing",
      payload: { senderId: state.senderId, senderName: state.senderName }
    });
  }

  function toggleSendVoiceButtons() {
    const hasText = Boolean($("messageInput")?.value.trim());
    if (hasText) {
      $("voiceRecordBtn")?.classList.add("hidden");
      $("sendBtn")?.classList.remove("hidden");
    } else {
      $("sendBtn")?.classList.add("hidden");
      $("voiceRecordBtn")?.classList.remove("hidden");
    }
  }

  /* WhatsApp SVG Double Tick */
  function createDoubleTickSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 15");
    svg.setAttribute("class", "message-ticks-svg");
    svg.setAttribute("fill", "currentColor");
    svg.innerHTML = `
      <path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.064-.512zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/>
    `;
    return svg;
  }

  /* Audio Voice Player Component */
  function createAudioPlayer(audioUrl) {
    const bubble = document.createElement("div");
    bubble.className = "wa-audio-bubble";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "audio-play-btn";
    playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

    const trackWrap = document.createElement("div");
    trackWrap.className = "audio-track-wrap";

    const progBar = document.createElement("div");
    progBar.className = "audio-progress-bar";
    const progFill = document.createElement("div");
    progFill.className = "audio-progress-fill";
    progBar.appendChild(progFill);

    const durText = document.createElement("span");
    durText.className = "audio-duration";
    durText.textContent = "0:00";

    trackWrap.append(progBar, durText);
    bubble.append(playBtn, trackWrap);

    const audio = new Audio(audioUrl);
    audio.addEventListener("loadedmetadata", () => {
      durText.textContent = formatDuration(audio.duration * 1000);
    });

    audio.addEventListener("timeupdate", () => {
      const pct = (audio.currentTime / (audio.duration || 1)) * 100;
      progFill.style.width = `${pct}%`;
      durText.textContent = formatDuration(audio.currentTime * 1000);
    });

    audio.addEventListener("ended", () => {
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
      progFill.style.width = "0%";
    });

    playBtn.onclick = () => {
      if (audio.paused) {
        document.querySelectorAll("audio").forEach(a => {
          if (a !== audio) a.pause();
        });
        audio.play().catch(() => {});
        playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
      } else {
        audio.pause();
        playBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
      }
    };

    return bubble;
  }

  function renderMessage(message, isNew = false) {
    if (!message || message.id == null) return;
    const id = String(message.id);
    state.messages.set(id, message);

    if (state.seen.has(id)) { updateMessage(message); return; }
    state.seen.add(id);

    const container = $("chatMessages");
    if (!container) return;

    const decoded = decodeMessageBody(message.body);
    const own = message.sender_id === state.senderId;

    if (isNew && !own) {
      playNotificationSound();
      triggerDesktopNotification(`Guest-${String(message.sender_id).slice(0, 4)}`, decoded.text || "Sent a media attachment");
    }

    const article = document.createElement("article");
    article.className = `message${own ? " own" : ""}`;
    article.dataset.messageId = id;

    if (!own) {
      const sender = document.createElement("span");
      sender.className = "message-sender";
      sender.textContent = `Guest-${String(message.sender_id).slice(0, 4)}`;
      article.appendChild(sender);
    }

    if (decoded.replyTo) {
      const reply = document.createElement("div");
      reply.className = "reply-quote";
      reply.textContent = `Replying to #${decoded.replyTo}`;
      article.appendChild(reply);
    }

    // Media & Voice Rendering
    if (decoded.media && decoded.media.data) {
      const mediaWrap = document.createElement("div");
      mediaWrap.className = "chat-media-card";

      if (decoded.media.type === "voice" || decoded.media.type === "audio") {
        mediaWrap.appendChild(createAudioPlayer(decoded.media.data));
      } else if (decoded.media.type === "image") {
        const img = document.createElement("img");
        img.src = decoded.media.data;
        img.alt = "Attachment";
        img.onclick = () => openLightbox("image", decoded.media.data);
        mediaWrap.appendChild(img);
      } else if (decoded.media.type === "video") {
        const vid = document.createElement("video");
        vid.src = decoded.media.data;
        vid.controls = true;
        mediaWrap.appendChild(vid);
      } else {
        const fileCard = document.createElement("a");
        fileCard.href = decoded.media.data;
        fileCard.download = decoded.media.name || "document";
        fileCard.className = "chat-file-card";
        fileCard.innerHTML = `
          <div class="chat-file-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          </div>
          <div class="chat-file-meta">
            <strong>${escapeHtml(decoded.media.name || "Attachment")}</strong>
            <small>Download file</small>
          </div>
        `;
        mediaWrap.appendChild(fileCard);
      }
      article.appendChild(mediaWrap);
    }

    if (decoded.text) {
      const content = document.createElement("div");
      content.className = "message-text";
      content.textContent = message.deleted_at ? "This message was deleted." : decoded.text;
      article.appendChild(content);
    }

    // Reactions container
    const reactionsRow = document.createElement("div");
    reactionsRow.className = "message-reactions-row";
    article.appendChild(reactionsRow);

    // Meta (Time + Flame Icon + SVG Double Tick)
    const metaRow = document.createElement("div");
    metaRow.className = "message-meta-row";

    if (decoded.burnerTtl > 0 && !message.deleted_at) {
      const flame = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      flame.setAttribute("viewBox", "0 0 24 24");
      flame.setAttribute("class", "burner-icon");
      flame.setAttribute("fill", "none");
      flame.setAttribute("stroke", "currentColor");
      flame.setAttribute("stroke-width", "2");
      flame.innerHTML = `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path>`;
      metaRow.appendChild(flame);

      setTimeout(() => {
        article.classList.add("hidden");
        if (own) deleteMessage(message, true);
      }, decoded.burnerTtl * 1000);
    }

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(message.created_at);
    metaRow.appendChild(time);

    if (own && !message.deleted_at) {
      metaRow.appendChild(createDoubleTickSvg());
    }

    article.appendChild(metaRow);

    // Context Action Controls
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const reactBtn = document.createElement("button");
    reactBtn.className = "msg-action-btn";
    reactBtn.type = "button";
    reactBtn.innerHTML = `<span>🙂</span> React`;
    reactBtn.onclick = (e) => openEmojiPicker(e, id);
    actions.appendChild(reactBtn);

    const replyBtn = document.createElement("button");
    replyBtn.className = "msg-action-btn";
    replyBtn.type = "button";
    replyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg> Reply`;
    replyBtn.onclick = () => setReply(message);
    actions.appendChild(replyBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-action-btn";
    copyBtn.type = "button";
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`;
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(decoded.text || decoded.media?.data || "");
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`), 1200);
    };
    actions.appendChild(copyBtn);

    if (own && !message.deleted_at) {
      if (decoded.text) {
        const editBtn = document.createElement("button");
        editBtn.className = "msg-action-btn";
        editBtn.type = "button";
        editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> Edit`;
        editBtn.onclick = () => editMessage(message);
        actions.appendChild(editBtn);
      }

      const delBtn = document.createElement("button");
      delBtn.className = "msg-action-btn";
      delBtn.type = "button";
      delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg> Delete`;
      delBtn.onclick = () => deleteMessage(message);
      actions.appendChild(delBtn);
    }

    article.appendChild(actions);
    container.appendChild(article);
    container.scrollTop = container.scrollHeight;
  }

  function updateMessage(message) {
    if (!message || message.id == null) return;
    const id = String(message.id);
    state.messages.set(id, message);
    const existing = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (!existing) { renderMessage(message); return; }

    const decoded = decodeMessageBody(message.body);
    const content = existing.querySelector(".message-text");
    if (content) content.textContent = message.deleted_at ? "This message was deleted." : decoded.text;
  }

  function removeMessage(id) {
    document.querySelector(`[data-message-id="${CSS.escape(String(id))}"]`)?.remove();
    state.messages.delete(String(id));
    state.seen.delete(String(id));
  }

  function setReply(message) {
    state.replyTarget = message.id;
    const decoded = decodeMessageBody(message.body);
    $("replyComposerPreview")?.classList.remove("hidden");
    setText("replyPreviewText", (decoded.text || decoded.media?.name || "Attachment").slice(0, 80));
    $("messageInput")?.focus();
  }

  function cancelReply() {
    state.replyTarget = null;
    $("replyComposerPreview")?.classList.add("hidden");
    setText("replyPreviewText", "");
  }

  /* Safe Media Message Dispatcher */
  async function sendMediaMessage(mediaObj) {
    if (!state.room || !state.client) {
      alert("Please join or create a room first.");
      return;
    }

    try {
      const payloadBody = encodeMessageBody("", state.replyTarget, mediaObj, state.activeBurnerTtl);

      const { error } = await state.client.from("messages").insert({
        room_id: state.room.id,
        sender_id: state.senderId,
        body: payloadBody
      });

      if (error) throw error;
      cancelReply();
    } catch (err) {
      console.error("Media send error:", err);
      alert("Attachment send failed: " + (err.message || "File too large or network error."));
    }
  }

  /* Text Message Send Dispatcher */
  async function sendMessage(event) {
    event?.preventDefault();
    const input = $("messageInput");
    const text = input?.value.trim();
    if (!text || !state.room || !state.client) return;

    if (text.length > CONFIG.MAX_MESSAGE_LENGTH) {
      alert("Message exceeds maximum length of 2000 characters.");
      return;
    }

    const btn = $("sendBtn");
    if (btn) btn.disabled = true;

    try {
      const { error } = await state.client.from("messages").insert({
        room_id: state.room.id,
        sender_id: state.senderId,
        body: encodeMessageBody(text, state.replyTarget, null, state.activeBurnerTtl)
      });
      if (error) throw error;
      input.value = "";
      toggleSendVoiceButtons();
      cancelReply();
    } catch (err) {
      console.error("Send message error:", err);
    } finally {
      if (btn) btn.disabled = false;
      input?.focus();
    }
  }

  async function editMessage(message) {
    if (message.sender_id !== state.senderId) return;
    const decoded = decodeMessageBody(message.body);
    const replacement = prompt("Edit message:", decoded.text);
    if (replacement === null) return;
    const text = replacement.trim();
    if (!text || text.length > CONFIG.MAX_MESSAGE_LENGTH) return;

    try {
      await state.client
        .from("messages")
        .update({ body: encodeMessageBody(text, decoded.replyTo, decoded.media, decoded.burnerTtl), edited_at: new Date().toISOString() })
        .eq("id", message.id);
    } catch {}
  }

  async function deleteMessage(message, silent = false) {
    if (message.sender_id !== state.senderId) return;
    if (!silent && !confirm("Delete this message?")) return;
    try {
      await state.client
        .from("messages")
        .update({ deleted_at: new Date().toISOString(), body: encodeMessageBody("This message was deleted.") })
        .eq("id", message.id);
    } catch {}
  }

  /* WhatsApp Floating Emoji Reactions */
  function openEmojiPicker(event, messageId) {
    event.stopPropagation();
    state.activeReactionTargetId = messageId;
    const popup = $("emojiPickerPopup");
    if (!popup) return;

    const rect = event.target.getBoundingClientRect();
    popup.style.top = `${rect.top - 46}px`;
    popup.style.left = `${Math.min(window.innerWidth - 240, rect.left)}px`;
    popup.classList.remove("hidden");
  }

  function handleEmojiSelect(emoji) {
    if (!state.activeReactionTargetId || !state.channel) return;
    const targetId = state.activeReactionTargetId;

    const payload = {
      messageId: targetId,
      emoji,
      senderId: state.senderId
    };

    handleIncomingReaction(payload);

    state.channel.send({
      type: "broadcast",
      event: "reaction",
      payload
    });

    $("emojiPickerPopup")?.classList.add("hidden");
  }

  function handleIncomingReaction({ messageId, emoji, senderId }) {
    if (!state.reactions.has(messageId)) {
      state.reactions.set(messageId, new Map());
    }
    const msgReactions = state.reactions.get(messageId);
    if (!msgReactions.has(emoji)) {
      msgReactions.set(emoji, new Set());
    }

    const set = msgReactions.get(emoji);
    if (set.has(senderId)) {
      set.delete(senderId);
      if (set.size === 0) msgReactions.delete(emoji);
    } else {
      set.add(senderId);
    }

    renderReactions(messageId);
  }

  function renderReactions(messageId) {
    const msgEl = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!msgEl) return;
    const row = msgEl.querySelector(".message-reactions-row");
    if (!row) return;

    row.replaceChildren();
    const map = state.reactions.get(messageId);
    if (!map || map.size === 0) return;

    map.forEach((set, emoji) => {
      const pill = document.createElement("span");
      pill.className = "reaction-pill";
      pill.innerHTML = `<span>${emoji}</span> <span class="reaction-count">${set.size}</span>`;
      row.appendChild(pill);
    });
  }

  /* WhatsApp Voice Note Recorder Implementation */
  async function startVoiceRecording() {
    if (state.isRecordingVoice) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mediaRecorder = new MediaRecorder(stream);
      state.audioChunks = [];

      state.mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
      };

      state.mediaRecorder.onstop = async () => {
        clearInterval(state.recordTimerInterval);
        stream.getTracks().forEach(t => t.stop());

        if (state.audioChunks.length === 0) return;
        const audioBlob = new Blob(state.audioChunks, { type: "audio/webm" });

        const reader = new FileReader();
        reader.onloadend = () => {
          sendMediaMessage({
            type: "voice",
            data: reader.result,
            name: `voice_${Date.now()}.webm`
          });
        };
        reader.readAsDataURL(audioBlob);
      };

      state.mediaRecorder.start();
      state.isRecordingVoice = true;
      state.recordStartTime = Date.now();

      $("voiceRecordingWave")?.classList.remove("hidden");
      $("voiceRecordBtn")?.classList.add("recording");
      $("cancelVoiceBtn")?.classList.remove("hidden");

      state.recordTimerInterval = setInterval(() => {
        const elapsed = Date.now() - state.recordStartTime;
        setText("voiceRecordTimer", formatDuration(elapsed));
      }, 500);
    } catch {
      alert("Microphone permission denied for voice notes.");
    }
  }

  function stopVoiceRecording(send = true) {
    if (!state.isRecordingVoice || !state.mediaRecorder) return;
    if (!send) state.audioChunks = [];
    state.mediaRecorder.stop();
    state.isRecordingVoice = false;

    $("voiceRecordingWave")?.classList.add("hidden");
    $("voiceRecordBtn")?.classList.remove("recording");
    $("cancelVoiceBtn")?.classList.add("hidden");
    setText("voiceRecordTimer", "0:00");
  }

  /* Media Lightbox Viewer */
  function openLightbox(type, src) {
    const container = $("lightboxMediaContainer");
    if (!container) return;
    container.replaceChildren();

    if (type === "image") {
      const img = document.createElement("img");
      img.src = src;
      container.appendChild(img);
    }
    $("mediaLightboxModal")?.classList.remove("hidden");
  }

  /* QR Code & Share */
  function showQrCode() {
    if (!state.roomCode) return;
    const url = new URL(location.href);
    url.searchParams.set("room", state.roomCode);
    $("qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url.href)}`;
    $("qrModal")?.classList.remove("hidden");
  }

  async function shareRoom() {
    if (!state.roomCode) return;
    const url = new URL(location.href);
    url.searchParams.set("room", state.roomCode);
    if (navigator.share) {
      await navigator.share({ title: "NETBAND Room", text: `Join: ${state.roomCode}`, url: url.href });
    } else {
      await navigator.clipboard.writeText(url.href);
      alert("Room link copied to clipboard!");
    }
  }

  function searchMessages(term) {
    state.searchTerm = String(term || "").toLowerCase();
    document.querySelectorAll("#chatMessages .message").forEach(el => {
      const txt = el.querySelector(".message-text")?.textContent || "";
      el.classList.toggle("hidden", !txt.toLowerCase().includes(state.searchTerm));
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  /* LiveKit Video & Audio Streaming */
  async function requestLiveKitToken() {
    const { data, error } = await state.client.functions.invoke(CONFIG.TOKEN_FUNCTION, {
      body: { roomName: `netband-${state.room.id}`, participantName: state.senderName }
    });
    if (error || !data?.token) throw new Error("LiveKit Token failure.");
    return data.token;
  }

  async function joinCall(withVideo = false) {
    if (state.callConnecting || state.call) return;
    state.callConnecting = true;
    setText("callStatus", "Connecting…");
    $("callOverlay")?.classList.remove("hidden");

    try {
      const token = await requestLiveKitToken();
      const call = new livekitLibrary.Room({ adaptiveStream: true, dynacast: true });
      state.call = call;

      registerCallEvents(call);
      await call.connect(CONFIG.LIVEKIT_URL, token);

      const tracks = await livekitLibrary.createLocalTracks({ audio: true, video: withVideo });
      state.localTracks = tracks;
      for (const track of tracks) await call.localParticipant.publishTrack(track);

      setText("callStatus", "Call connected");
      $("screenShareBtn")?.classList.remove("hidden");
      updateVideoGrid();
    } catch (err) {
      await leaveCall();
      alert("Call connection failed. Please ensure camera/mic permissions are granted.");
    } finally {
      state.callConnecting = false;
    }
  }

  function registerCallEvents(call) {
    call
      .on(livekitLibrary.RoomEvent.ParticipantConnected, updateVideoGrid)
      .on(livekitLibrary.RoomEvent.ParticipantDisconnected, p => {
        $(`video-${p.identity}`)?.remove();
        updateVideoGrid();
      })
      .on(livekitLibrary.RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === "audio") {
          const el = track.attach();
          el.style.display = "none";
          document.body.appendChild(el);
          return;
        }
        if (track.kind === "video") attachVideoTrack(track, participant);
      })
      .on(livekitLibrary.RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach(el => el.remove());
        updateVideoGrid();
      })
      .on(livekitLibrary.RoomEvent.Disconnected, leaveCall);
  }

  function attachVideoTrack(track, participant) {
    const grid = $("videoGrid");
    if (!grid) return;

    let tile = $(`video-${participant.identity}`);
    if (!tile) {
      tile = document.createElement("div");
      tile.id = `video-${participant.identity}`;
      tile.className = "video-tile";

      const label = document.createElement("div");
      label.className = "video-label";
      label.textContent = participant.name || participant.identity;
      tile.appendChild(label);
      grid.appendChild(tile);
    }

    const mediaEl = track.attach();
    tile.insertBefore(mediaEl, tile.firstChild);
  }

  function updateVideoGrid() {
    if (!state.call) return;
    const local = state.call.localParticipant;
    if (local) {
      local.videoTrackPublications.forEach(pub => {
        if (pub.videoTrack) attachVideoTrack(pub.videoTrack, local);
      });
    }
  }

  async function toggleMicrophone() {
    if (!state.call) return;
    const enabled = state.call.localParticipant.isMicrophoneEnabled;
    await state.call.localParticipant.setMicrophoneEnabled(!enabled);
    const span = $("muteBtn")?.querySelector("span");
    if (span) span.textContent = enabled ? "Unmute" : "Muted";
  }

  async function toggleCamera() {
    if (!state.call) return;
    const enabled = state.call.localParticipant.isCameraEnabled;
    await state.call.localParticipant.setCameraEnabled(!enabled);
    const span = $("cameraBtn")?.querySelector("span");
    if (span) span.textContent = enabled ? "Cam On" : "Cam Off";
  }

  async function toggleScreenShare() {
    if (!state.call) return;
    try {
      state.isScreenSharing = !state.isScreenSharing;
      await state.call.localParticipant.setScreenShareEnabled(state.isScreenSharing);
      $("screenShareBtn")?.classList.toggle("active", state.isScreenSharing);
    } catch {
      state.isScreenSharing = false;
    }
  }

  async function leaveCall() {
    const call = state.call;
    state.call = null;
    if (call) try { await call.disconnect(); } catch {}

    state.localTracks.forEach(t => { try { t.stop(); } catch {} });
    state.localTracks = [];
    state.isScreenSharing = false;
    document.querySelectorAll("audio").forEach(el => el.remove());

    $("callOverlay")?.classList.add("hidden");
    $("screenShareBtn")?.classList.add("hidden");
    $("videoGrid")?.replaceChildren();
    setText("callStatus", "Not in a call");
  }

  async function leaveRoom() {
    clearInterval(state.timer);
    await leaveCall();
    await disconnectRealtime();

    state.room = null;
    state.roomCode = null;

    document.querySelector(".wa-app-window")?.classList.remove("in-chat");
    $("activeChatWrapper")?.classList.add("hidden");
    $("emptyPlaceholder")?.classList.remove("hidden");

    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState({}, "", url);
  }

  function setupEventListeners() {
    $("createBtn")?.addEventListener("click", createRoom);
    $("joinForm")?.addEventListener("submit", e => { e.preventDefault(); joinRoom($("roomInput")?.value); });
    $("roomInput")?.addEventListener("input", e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""); });

    $("messageForm")?.addEventListener("submit", sendMessage);
    $("messageInput")?.addEventListener("input", emitTyping);

    // Voice Recorder Buttons
    $("voiceRecordBtn")?.addEventListener("click", () => {
      if (!state.isRecordingVoice) startVoiceRecording();
      else stopVoiceRecording(true);
    });

    $("cancelVoiceBtn")?.addEventListener("click", () => stopVoiceRecording(false));

    // File Attachments (Size capped to 2MB for direct realtime base64 payload safety)
    $("attachmentBtn")?.addEventListener("click", () => $("attachmentInput")?.click());
    $("attachmentInput")?.addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 2.5 * 1024 * 1024) {
        alert("Maximum attachment limit is 2.5MB for instant websocket transfer.");
        e.target.value = "";
        return;
      }

      const reader = new FileReader();
      const isImg = file.type.startsWith("image/");
      const isVid = file.type.startsWith("video/");

      reader.onloadend = () => {
        sendMediaMessage({
          type: isImg ? "image" : isVid ? "video" : "file",
          data: reader.result,
          name: file.name
        });
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    });

    // Burner Self-Destruct Dropdown
    $("burnerToggleBtn")?.addEventListener("click", e => {
      e.stopPropagation();
      $("burnerMenu")?.classList.toggle("hidden");
    });

    document.querySelectorAll(".dropdown-item").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".dropdown-item").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeBurnerTtl = Number(btn.dataset.ttl || 0);
        $("burnerToggleBtn")?.classList.toggle("active", state.activeBurnerTtl > 0);
        $("burnerMenu")?.classList.add("hidden");
      });
    });

    // Desktop Push Notification Toggle
    $("notifyToggleBtn")?.addEventListener("click", async () => {
      if ("Notification" in window) {
        const perm = await Notification.requestPermission();
        state.notificationsEnabled = perm === "granted";
        $("notifyToggleBtn")?.classList.toggle("active", state.notificationsEnabled);
        alert(state.notificationsEnabled ? "Desktop Notifications Enabled." : "Notifications denied.");
      }
    });

    // Floating Emoji Bar clicks
    document.querySelectorAll("#emojiPickerPopup button").forEach(b => {
      b.addEventListener("click", () => handleEmojiSelect(b.dataset.emoji));
    });

    document.addEventListener("click", e => {
      if (!e.target.closest("#emojiPickerPopup") && !e.target.closest(".msg-action-btn")) {
        $("emojiPickerPopup")?.classList.add("hidden");
      }
      if (!e.target.closest(".wa-dropdown-wrap")) {
        $("burnerMenu")?.classList.add("hidden");
      }
    });

    $("closeLightboxBtn")?.addEventListener("click", () => $("mediaLightboxModal")?.classList.add("hidden"));
    $("cancelReplyBtn")?.addEventListener("click", cancelReply);
    $("showQrBtn")?.addEventListener("click", showQrCode);
    $("closeQrBtn")?.addEventListener("click", () => $("qrModal")?.classList.add("hidden"));
    $("shareRoomBtn")?.addEventListener("click", shareRoom);

    $("backToSidebarBtn")?.addEventListener("click", () => {
      document.querySelector(".wa-app-window")?.classList.remove("in-chat");
    });

    $("messageSearch")?.addEventListener("input", e => searchMessages(e.target.value));
    $("leaveBtn")?.addEventListener("click", () => { if (confirm("Leave this temporary space?")) leaveRoom(); });

    $("joinVoiceBtn")?.addEventListener("click", () => joinCall(false));
    $("joinVideoBtn")?.addEventListener("click", () => joinCall(true));
    $("muteBtn")?.addEventListener("click", toggleMicrophone);
    $("cameraBtn")?.addEventListener("click", toggleCamera);
    $("screenShareBtn")?.addEventListener("click", toggleScreenShare);
    $("leaveCallBtn")?.addEventListener("click", leaveCall);

    window.addEventListener("online", setNetworkStatus);
    window.addEventListener("offline", setNetworkStatus);
  }

  async function start() {
    setNetworkStatus();
    setupEventListeners();

    const params = new URLSearchParams(location.search);
    const code = params.get("room");
    if (code) {
      if ($("roomInput")) $("roomInput").value = code.toUpperCase();
      await joinRoom(code);
    }
  }

  start();
})();
