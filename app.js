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
    call: null,
    callConnecting: false,
    busy: false,
    searchTerm: "",
    localTracks: []
  };

  function getSenderId() {
    const key = "netband_sender_id";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
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
    if (!supabaseLibrary?.createClient) {
      throw new Error("Supabase SDK load nahi hua. Page refresh karein.");
    }

    if (!state.client) {
      state.client = supabaseLibrary.createClient(
        CONFIG.SUPABASE_URL,
        CONFIG.SUPABASE_KEY
      );
    }

    return state.client;
  }

  function setText(id, text) {
    const element = $(id);
    if (element) element.textContent = text;
  }

  function showError(id, message = "") {
    setText(id, message);
  }

  function setBusy(value) {
    state.busy = value;
    if ($("createBtn")) $("createBtn").disabled = value;
    if ($("roomInput")) $("roomInput").disabled = value;
    if ($("joinForm")) {
      const button = $("joinForm").querySelector('button[type="submit"]');
      if (button) button.disabled = value;
    }
  }

  function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => chars[byte % chars.length]).join("");
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  function decodeMessageBody(body) {
    const prefix = "__NETBAND_V2__:";
    if (typeof body !== "string" || !body.startsWith(prefix)) {
      return { text: body || "", replyTo: null };
    }

    try {
      const data = JSON.parse(body.slice(prefix.length));
      return {
        text: typeof data.text === "string" ? data.text : "",
        replyTo: data.replyTo || null
      };
    } catch {
      return { text: body, replyTo: null };
    }
  }

  function encodeMessageBody(text, replyTo = null) {
    return "__NETBAND_V2__:" + JSON.stringify({ text, replyTo });
  }

  function setNetworkStatus() {
    const online = navigator.onLine;
    setText("networkLabel", online ? "Internet connected" : "You're offline");

    const dot = $("onlineDot");
    if (dot) {
      dot.style.background = online ? "var(--success)" : "var(--danger)";
      dot.style.boxShadow = online
        ? "0 0 10px rgba(54, 229, 162, 0.7)"
        : "0 0 10px rgba(255, 85, 119, 0.7)";
    }
  }

  function setChatStatus(text) {
    setText("chatStatus", text);
  }

  function showChat(room) {
    state.room = room;
    state.roomCode = room.code;
    state.expiresAt = new Date(room.expires_at).getTime();

    $("setupPanel")?.classList.add("hidden");
    $("chatPanel")?.classList.remove("hidden");

    setText("chatTitle", "Temporary room");
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
        setText("expiryTitle", "Room time has ended");
        if ($("expiryBar")) $("expiryBar").style.width = "0%";
        leaveRoom();
        showError("setupError", "Room expire ho gaya. Naya room banayein.");
        return;
      }

      setText("expiryTitle", `Room expires in ${formatDuration(remaining)}`);

      if ($("expiryBar")) {
        $("expiryBar").style.width = `${Math.min(100, (remaining / CONFIG.ROOM_DURATION) * 100)}%`;
      }
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
          .insert({
            code,
            expires_at: new Date(Date.now() + CONFIG.ROOM_DURATION).toISOString()
          })
          .select("id,code,created_at,expires_at")
          .single();

        if (!error) {
          createdRoom = data;
          break;
        }

        if (!String(error.message || "").toLowerCase().includes("duplicate")) {
          throw error;
        }
      }

      if (!createdRoom) throw new Error("Room create nahi hua. Dobara try karein.");

      await connectToRoom(createdRoom);
    } catch (error) {
      console.error("Create room:", error);
      showError("setupError", error.message || "Room create nahi ho saka.");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(code) {
    if (state.busy) return;
    const roomCode = String(code || "").trim().toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(roomCode)) {
      showError("setupError", "8-characters ka valid code daalein.");
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
      if (!data) throw new Error("Room nahi mila ya expire ho gaya.");

      await connectToRoom(data);
    } catch (error) {
      console.error("Join room:", error);
      showError("setupError", error.message || "Room join nahi hua.");
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

    showChat(room);
    setChatStatus("Connecting...");

    try {
      const client = initializeBackend();
      const { data, error } = await client
        .from("messages")
        .select("id,room_id,sender_id,body,created_at,edited_at,deleted_at")
        .eq("room_id", room.id)
        .order("created_at", { ascending: true })
        .limit(300);

      if (error) throw error;

      (data || []).forEach(renderMessage);

      state.channel = client
        .channel(`netband-room-${room.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "messages",
            filter: `room_id=eq.${room.id}`
          },
          payload => {
            if (payload.eventType === "INSERT") renderMessage(payload.new);
            else if (payload.eventType === "UPDATE") updateMessage(payload.new);
            else if (payload.eventType === "DELETE") removeMessage(payload.old.id);
          }
        )
        .subscribe(status => {
          if (status === "SUBSCRIBED") setChatStatus("Connected · Realtime");
          else if (status === "CHANNEL_ERROR") setChatStatus("Connection error");
          else if (status === "CLOSED") setChatStatus("Disconnected");
        });
    } catch (error) {
      console.error("Connect room:", error);
      showError("chatError", error.message || "Messages load nahi hue.");
      setChatStatus("Connection failed");
    }
  }

  async function disconnectRealtime() {
    if (state.channel && state.client) {
      await state.client.removeChannel(state.channel);
    }
    state.channel = null;
  }

  function renderMessage(message) {
    if (!message || message.id == null) return;

    const id = String(message.id);
    state.messages.set(id, message);

    if (state.seen.has(id)) {
      updateMessage(message);
      return;
    }

    state.seen.add(id);

    const container = $("chatMessages");
    if (!container) return;

    container.querySelector(".empty-state")?.remove();

    const decoded = decodeMessageBody(message.body);
    const own = message.sender_id === state.senderId;

    const article = document.createElement("article");
    article.className = `message${own ? " own" : ""}`;
    article.dataset.messageId = id;

    // Fixed: Matches .message-sender in CSS
    const sender = document.createElement("span");
    sender.className = "message-sender";
    sender.textContent = own ? "You" : `Guest-${String(message.sender_id).slice(0, 5)}`;

    if (decoded.replyTo) {
      const reply = document.createElement("div");
      reply.className = "reply-quote";
      reply.textContent = `Replying to: #${decoded.replyTo}`;
      article.appendChild(reply);
    }

    const content = document.createElement("div");
    content.className = "message-text";
    content.textContent = message.deleted_at ? "This message was deleted." : decoded.text;

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = formatTime(message.created_at) + (message.edited_at ? " · edited" : "");

    const actions = document.createElement("div");
    actions.className = "message-actions";

    const replyButton = document.createElement("button");
    replyButton.type = "button";
    replyButton.textContent = "Reply";
    replyButton.addEventListener("click", () => setReply(message));
    actions.appendChild(replyButton);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(decoded.text);
        copyButton.textContent = "Copied";
        setTimeout(() => (copyButton.textContent = "Copy"), 1500);
      } catch {
        copyButton.textContent = "Failed";
      }
    });
    actions.appendChild(copyButton);

    if (own && !message.deleted_at) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => editMessage(message));
      actions.appendChild(editButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => deleteMessage(message));
      actions.appendChild(deleteButton);
    }

    article.append(sender, content, time, actions);
    container.appendChild(article);
    container.scrollTop = container.scrollHeight;
  }

  function updateMessage(message) {
    if (!message || message.id == null) return;

    const id = String(message.id);
    state.messages.set(id, message);

    const existing = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
    if (!existing) {
      renderMessage(message);
      return;
    }

    const decoded = decodeMessageBody(message.body);
    const content = existing.querySelector(".message-text");
    const time = existing.querySelector(".message-time");

    if (content) {
      content.textContent = message.deleted_at ? "This message was deleted." : decoded.text;
    }

    if (time) {
      time.textContent = formatTime(message.created_at) + (message.edited_at ? " · edited" : "");
    }
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
    setText("replyPreviewText", decoded.text.slice(0, 100) || "Message");
    $("messageInput")?.focus();
  }

  function cancelReply() {
    state.replyTarget = null;
    $("replyComposerPreview")?.classList.add("hidden");
    setText("replyPreviewText", "");
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const input = $("messageInput");
    const text = input?.value.trim();

    if (!text || !state.room || !state.client) return;

    if (text.length > CONFIG.MAX_MESSAGE_LENGTH) {
      showError("chatError", "Message 2000 characters se chhota hona chahiye.");
      return;
    }

    const button = $("sendBtn");
    if (button) button.disabled = true;
    showError("chatError");

    try {
      const { error } = await state.client.from("messages").insert({
        room_id: state.room.id,
        sender_id: state.senderId,
        body: encodeMessageBody(text, state.replyTarget)
      });

      if (error) throw error;
      input.value = "";
      cancelReply();
    } catch (error) {
      console.error("Send message:", error);
      showError("chatError", error.message || "Message send nahi hua.");
    } finally {
      if (button) button.disabled = false;
      input?.focus();
    }
  }

  async function editMessage(message) {
    if (message.sender_id !== state.senderId) return;
    const decoded = decodeMessageBody(message.body);
    const replacement = prompt("Message edit karein:", decoded.text);
    if (replacement === null) return;

    const text = replacement.trim();
    if (!text || text.length > CONFIG.MAX_MESSAGE_LENGTH) {
      showError("chatError", "Invalid message length.");
      return;
    }

    try {
      const { error } = await state.client
        .from("messages")
        .update({
          body: encodeMessageBody(text, decoded.replyTo),
          edited_at: new Date().toISOString()
        })
        .eq("id", message.id)
        .eq("sender_id", state.senderId);

      if (error) throw error;
    } catch (error) {
      showError("chatError", error.message || "Edit fail hua.");
    }
  }

  async function deleteMessage(message) {
    if (message.sender_id !== state.senderId) return;
    if (!confirm("Message delete karna hai?")) return;

    try {
      const { error } = await state.client
        .from("messages")
        .update({
          deleted_at: new Date().toISOString(),
          body: encodeMessageBody("This message was deleted.")
        })
        .eq("id", message.id)
        .eq("sender_id", state.senderId);

      if (error) throw error;
    } catch (error) {
      showError("chatError", error.message || "Delete fail hua.");
    }
  }

  async function copyRoomCode() {
    if (!state.roomCode) return;
    try {
      await navigator.clipboard.writeText(state.roomCode);
      setText("copyCodeBtn", "Copied!");
      setTimeout(() => setText("copyCodeBtn", "Copy code"), 1500);
    } catch {
      showError("chatError", "Clipboard access nahi mila.");
    }
  }

  async function shareRoom() {
    if (!state.roomCode) {
      setText("roomShareStatus", "Pehle room create ya join karein.");
      return;
    }

    const url = new URL(location.href);
    url.searchParams.set("room", state.roomCode);

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Join my NETBAND room",
          text: `Room code: ${state.roomCode}`,
          url: url.href
        });
      } else {
        await navigator.clipboard.writeText(url.href);
        setText("roomShareStatus", "Room link copied!");
        setTimeout(() => setText("roomShareStatus", ""), 3000);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setText("roomShareStatus", "Link share nahi ho saka.");
      }
    }
  }

  function searchMessages(term) {
    state.searchTerm = String(term || "").toLowerCase();
    document.querySelectorAll("#chatMessages .message").forEach(element => {
      const text = element.querySelector(".message-text")?.textContent || "";
      element.classList.toggle("hidden", !text.toLowerCase().includes(state.searchTerm));
    });
  }

  async function requestLiveKitToken() {
    if (!state.client || !state.room) throw new Error("Pehle room join karein.");

    const { data, error } = await state.client.functions.invoke(CONFIG.TOKEN_FUNCTION, {
      body: {
        roomName: `netband-${state.room.id}`,
        participantName: state.senderName
      }
    });

    if (error) throw error;
    if (!data?.token) throw new Error("LiveKit token nahi mila.");
    return data.token;
  }

  async function joinCall(withVideo = false) {
    if (state.callConnecting || state.call) return;
    if (!livekitLibrary?.Room || !livekitLibrary?.createLocalTracks) {
      showError("callError", "LiveKit client load nahi hua.");
      return;
    }

    state.callConnecting = true;
    showError("callError");
    setText("callStatus", "Connecting...");

    try {
      const token = await requestLiveKitToken();
      const call = new livekitLibrary.Room({ adaptiveStream: true, dynacast: true });
      state.call = call;

      registerCallEvents(call);
      await call.connect(CONFIG.LIVEKIT_URL, token);

      const tracks = await livekitLibrary.createLocalTracks({
        audio: true,
        video: withVideo
      });

      state.localTracks = tracks;
      for (const track of tracks) {
        await call.localParticipant.publishTrack(track);
      }

      $("joinVoiceBtn").disabled = true;
      $("joinVideoBtn").disabled = true;
      $("muteBtn").disabled = false;
      $("cameraBtn").disabled = false;
      $("leaveCallBtn").disabled = false;

      setText("callStatus", "Call connected");
      updateParticipants();
      updateVideoGrid();
    } catch (error) {
      console.error("Join call:", error);
      await leaveCall();
      showError("callError", error.message || "Call connect nahi hui.");
      setText("callStatus", "Not in a call");
    } finally {
      state.callConnecting = false;
    }
  }

  function registerCallEvents(call) {
    call
      .on(livekitLibrary.RoomEvent.ParticipantConnected, () => {
        updateParticipants();
        updateVideoGrid();
      })
      .on(livekitLibrary.RoomEvent.ParticipantDisconnected, (participant) => {
        detachParticipant(participant);
        updateParticipants();
        updateVideoGrid();
      })
      .on(livekitLibrary.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        attachTrack(track, participant);
      })
      .on(livekitLibrary.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        detachTrack(track, participant);
      })
      .on(livekitLibrary.RoomEvent.TrackMuted, updateParticipants)
      .on(livekitLibrary.RoomEvent.TrackUnmuted, updateParticipants)
      .on(livekitLibrary.RoomEvent.Disconnected, leaveCall);
  }

  function attachTrack(track, participant) {
    if (track.kind === "audio") {
      const audioEl = track.attach();
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      return;
    }

    if (track.kind !== "video") return;

    const grid = $("videoGrid");
    if (!grid) return;

    $("videoEmpty")?.remove();
    const key = participant.identity;

    let tile = grid.querySelector(`[data-participant="${CSS.escape(key)}"]`);
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "video-tile";
      tile.dataset.participant = key;

      const name = document.createElement("div");
      name.className = "video-label";
      name.textContent = participant.name || participant.identity;

      tile.appendChild(name);
      grid.appendChild(tile);
    }

    const mediaElement = track.attach();
    mediaElement.autoplay = true;
    mediaElement.playsInline = true;
    tile.insertBefore(mediaElement, tile.firstChild);
  }

  function detachTrack(track, participant) {
    track.detach().forEach(el => el.remove());
    const tile = $("videoGrid")?.querySelector(`[data-participant="${CSS.escape(participant.identity)}"]`);
    if (tile && !tile.querySelector("video")) tile.remove();
    updateVideoGrid();
  }

  function detachParticipant(participant) {
    const tile = $("videoGrid")?.querySelector(`[data-participant="${CSS.escape(participant.identity)}"]`);
    tile?.remove();
  }

  function updateVideoGrid() {
    if (!state.call) return;
    const grid = $("videoGrid");
    if (!grid) return;

    const local = state.call.localParticipant;
    if (local) {
      const key = local.identity;
      let tile = grid.querySelector(`[data-participant="${CSS.escape(key)}"]`);

      if (!tile) {
        tile = document.createElement("div");
        tile.className = "video-tile";
        tile.dataset.participant = key;

        const name = document.createElement("div");
        name.className = "video-label";
        name.textContent = `${state.senderName} (You)`;

        tile.appendChild(name);
        grid.appendChild(tile);
      }

      local.videoTrackPublications.forEach(pub => {
        const track = pub.videoTrack;
        if (track && !tile.querySelector("video")) {
          $("videoEmpty")?.remove();
          const el = track.attach();
          el.autoplay = true;
          el.playsInline = true;
          tile.insertBefore(el, tile.firstChild);
        }
      });
    }

    if (!grid.querySelector(".video-tile") && !grid.querySelector("#videoEmpty")) {
      const empty = document.createElement("div");
      empty.id = "videoEmpty";
      empty.className = "video-empty";
      empty.innerHTML = `<span>◉</span><strong>No active call</strong><small>Join voice or video to connect with members.</small>`;
      grid.appendChild(empty);
    }
  }

  function updateParticipants() {
    const call = state.call;
    const list = $("participantList");
    if (!list) return;

    list.replaceChildren();

    if (!call) {
      list.innerHTML = `<p class="muted small">No participants yet.</p>`;
      setText("participantCount", "0");
      return;
    }

    const participants = [call.localParticipant, ...call.remoteParticipants.values()];
    setText("participantCount", String(participants.length));

    participants.forEach(p => {
      const row = document.createElement("div");
      row.className = "participant-item";
      const isYou = p === call.localParticipant;
      const mic = p.isMicrophoneEnabled ? "🎤" : "🔇";
      row.textContent = `${p.name || p.identity} ${isYou ? "(You)" : ""} · ${mic}`;
      list.appendChild(row);
    });
  }

  async function toggleMicrophone() {
    const call = state.call;
    if (!call) return;

    try {
      const enabled = call.localParticipant.isMicrophoneEnabled;
      await call.localParticipant.setMicrophoneEnabled(!enabled);
      setText("muteBtn", enabled ? "Unmute mic" : "Mute mic");
      updateParticipants();
    } catch (error) {
      showError("callError", "Microphone toggle fail hua.");
    }
  }

  async function toggleCamera() {
    const call = state.call;
    if (!call) return;

    try {
      const enabled = call.localParticipant.isCameraEnabled;
      await call.localParticipant.setCameraEnabled(!enabled);
      setText("cameraBtn", enabled ? "Turn camera on" : "Turn camera off");
      updateParticipants();
      updateVideoGrid();
    } catch (error) {
      showError("callError", "Camera toggle fail hua.");
    }
  }

  async function leaveCall() {
    const call = state.call;
    state.call = null;

    if (call) {
      try {
        await call.disconnect();
      } catch {}
    }

    state.localTracks.forEach(track => {
      try { track.stop(); } catch {}
    });
    state.localTracks = [];

    // Remove any attached remote audio elements
    document.querySelectorAll("audio").forEach(el => el.remove());

    $("joinVoiceBtn").disabled = false;
    $("joinVideoBtn").disabled = false;
    $("muteBtn").disabled = true;
    $("cameraBtn").disabled = true;
    $("leaveCallBtn").disabled = true;

    setText("muteBtn", "Mute mic");
    setText("cameraBtn", "Turn camera on");
    setText("callStatus", "Not in a call");

    $("videoGrid")?.replaceChildren();
    if ($("videoGrid")) {
      const empty = document.createElement("div");
      empty.id = "videoEmpty";
      empty.className = "video-empty";
      empty.innerHTML = `<span>◉</span><strong>No active call</strong><small>Join voice or video to connect with members.</small>`;
      $("videoGrid").appendChild(empty);
    }

    updateParticipants();
  }

  async function leaveRoom() {
    clearInterval(state.timer);
    state.timer = null;

    await leaveCall();
    await disconnectRealtime();

    state.room = null;
    state.roomCode = null;
    state.expiresAt = null;
    state.replyTarget = null;
    state.seen.clear();
    state.messages.clear();

    $("chatPanel")?.classList.add("hidden");
    $("setupPanel")?.classList.remove("hidden");
    $("replyComposerPreview")?.classList.add("hidden");

    if ($("chatMessages")) {
      $("chatMessages").replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `<span>✧</span><strong>Your conversation starts here</strong><p>Share the room code with the person you want to chat with.</p>`;
      $("chatMessages").appendChild(empty);
    }

    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState({}, "", url);

    showError("chatError");
    showError("callError");
  }

  function setupEventListeners() {
    $("createBtn")?.addEventListener("click", createRoom);

    $("joinForm")?.addEventListener("submit", event => {
      event.preventDefault();
      joinRoom($("roomInput")?.value);
    });

    $("roomInput")?.addEventListener("input", event => {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "");
    });

    $("messageForm")?.addEventListener("submit", sendMessage);
    $("cancelReplyBtn")?.addEventListener("click", cancelReply);
    $("copyCodeBtn")?.addEventListener("click", copyRoomCode);
    $("shareRoomBtn")?.addEventListener("click", shareRoom);

    $("messageSearch")?.addEventListener("input", e => searchMessages(e.target.value));

    $("leaveBtn")?.addEventListener("click", async () => {
      if (confirm("Room chhodna hai?")) await leaveRoom();
    });

    $("joinVoiceBtn")?.addEventListener("click", () => joinCall(false));
    $("joinVideoBtn")?.addEventListener("click", () => joinCall(true));
    $("muteBtn")?.addEventListener("click", toggleMicrophone);
    $("cameraBtn")?.addEventListener("click", toggleCamera);
    $("leaveCallBtn")?.addEventListener("click", leaveCall);

    $("attachmentBtn")?.addEventListener("click", () => $("attachmentInput")?.click());
    $("attachmentInput")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          alert("File maximum 10MB ki honi chahiye.");
          e.target.value = "";
          return;
        }
        alert(`File selected: ${file.name}`);
        e.target.value = "";
      }
    });

    window.addEventListener("online", setNetworkStatus);
    window.addEventListener("offline", setNetworkStatus);
    window.addEventListener("pagehide", () => {
      clearInterval(state.timer);
      if (state.call) state.call.disconnect();
    });
  }

  async function start() {
    setNetworkStatus();
    setupEventListeners();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }

    const params = new URLSearchParams(location.search);
    const roomCode = params.get("room");

    if (roomCode) {
      if ($("roomInput")) $("roomInput").value = roomCode.toUpperCase();
      await joinRoom(roomCode);
    }
  }

  start();
})();
