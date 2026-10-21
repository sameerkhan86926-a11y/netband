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
    localTracks: [],
    renderedParticipants: new Set()
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
      throw new Error("Supabase SDK load nahi hua. Page refresh karo.");
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

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
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
    return "__NETBAND_V2__:" + JSON.stringify({
      text,
      replyTo
    });
  }

  function setNetworkStatus() {
    const online = navigator.onLine;

    setText(
      "networkLabel",
      online ? "Internet connected" : "You're offline"
    );

    const dot = $("onlineDot");

    if (dot) {
      dot.classList.toggle("online", online);
      dot.classList.toggle("offline", !online);
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
        setText("expiryBar", "");
        leaveRoom();
        showError("chatError", "Room expire ho gaya. Naya room create karo.");
        return;
      }

      setText("expiryTitle", `Room expires in ${formatDuration(remaining)}`);

      if ($("expiryBar")) {
        $("expiryBar").style.width =
          `${Math.min(100, remaining / CONFIG.ROOM_DURATION * 100)}%`;
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

      if (!createdRoom) {
        throw new Error("Room create nahi hua. Dobara try karo.");
      }

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
      showError("setupError", "8-character ka valid room code enter karo.");
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

      if (!data) {
        throw new Error("Room nahi mila ya room expire ho chuka hai.");
      }

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
        .select("id,room_id,sender_id,body,created_at,edited_at,deleted_at,reply_to,message_type,reactions")
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
            if (payload.eventType === "INSERT") {
              renderMessage(payload.new);
            } else if (payload.eventType === "UPDATE") {
              updateMessage(payload.new);
            } else if (payload.eventType === "DELETE") {
              removeMessage(payload.old.id);
            }
          }
        )
        .subscribe(status => {
          if (status === "SUBSCRIBED") {
            setChatStatus("Connected · Realtime");
          } else if (status === "CHANNEL_ERROR") {
            setChatStatus("Connection error");
          } else if (status === "CLOSED") {
            setChatStatus("Disconnected");
          }
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

    const author = document.createElement("div");
    author.className = "message-author";
    author.textContent = own ? "You" : `Guest ${String(message.sender_id).slice(0, 8)}`;

    const content = document.createElement("div");
    content.className = "message-text";
    content.textContent = message.deleted_at
      ? "This message was deleted."
      : decoded.text;

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent =
      formatTime(message.created_at) + (message.edited_at ? " · edited" : "");

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
      } catch {
        copyButton.textContent = "Copy failed";
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

    if (!message.deleted_at) {
      ["❤️", "😂", "👍"].forEach(emoji => {
        const reactionButton = document.createElement("button");
        reactionButton.type = "button";
        reactionButton.textContent = emoji;

        reactionButton.addEventListener("click", () => {
          toggleReaction(message, emoji);
        });

        actions.appendChild(reactionButton);
      });
    }

    article.append(author, content, time, actions);

    if (decoded.replyTo) {
      const reply = document.createElement("div");
      reply.className = "message-time";
      reply.textContent = `Reply to message #${decoded.replyTo}`;
      article.insertBefore(reply, content);
    }

    container.appendChild(article);
    container.scrollTop = container.scrollHeight;
  }

  function updateMessage(message) {
    if (!message || message.id == null) return;

    const id = String(message.id);
    state.messages.set(id, message);

    const existing = document.querySelector(
      `[data-message-id="${CSS.escape(id)}"]`
    );

    if (!existing) {
      renderMessage(message);
      return;
    }

    const decoded = decodeMessageBody(message.body);
    const content = existing.querySelector(".message-text");
    const time = existing.querySelector(".message-time");

    if (content) {
      content.textContent = message.deleted_at
        ? "This message was deleted."
        : decoded.text;
    }

    if (time) {
      time.textContent =
        formatTime(message.created_at) + (message.edited_at ? " · edited" : "");
    }
  }

  function removeMessage(id) {
    document.querySelector(
      `[data-message-id="${CSS.escape(String(id))}"]`
    )?.remove();

    state.messages.delete(String(id));
    state.seen.delete(String(id));
  }

  function setReply(message) {
    state.replyTarget = message.id;

    const decoded = decodeMessageBody(message.body);

    $("replyComposerPreview")?.classList.remove("hidden");

    setText(
      "replyPreviewText",
      decoded.text.slice(0, 150) || "Message"
    );

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
      showError("chatError", "Message 2000 characters se chhota rakho.");
      return;
    }

    const button = $("sendBtn");
    if (button) button.disabled = true;

    showError("chatError");

    try {
      const { error } = await state.client
        .from("messages")
        .insert({
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
    if (message.sender_id !== state.senderId) {
      showError("chatError", "Sirf apna message edit kar sakte ho.");
      return;
    }

    const decoded = decodeMessageBody(message.body);
    const replacement = prompt("Message edit karo:", decoded.text);

    if (replacement === null) return;

    const text = replacement.trim();

    if (!text || text.length > CONFIG.MAX_MESSAGE_LENGTH) {
      showError("chatError", "Message empty nahi ho sakta aur 2000 characters se kam hona chahiye.");
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
        .eq("sender_id", state.senderId)
        .eq("room_id", state.room.id);

      if (error) throw error;
    } catch (error) {
      console.error("Edit message:", error);
      showError("chatError", error.message || "Message edit nahi hua.");
    }
  }

  async function deleteMessage(message) {
    if (message.sender_id !== state.senderId) {
      showError("chatError", "Sirf apna message delete kar sakte ho.");
      return;
    }

    if (!confirm("Kya tum ye message delete karna chahte ho?")) return;

    try {
      const { error } = await state.client
        .from("messages")
        .update({
          deleted_at: new Date().toISOString(),
          body: encodeMessageBody("This message was deleted.")
        })
        .eq("id", message.id)
        .eq("sender_id", state.senderId)
        .eq("room_id", state.room.id);

      if (error) throw error;
    } catch (error) {
      console.error("Delete message:", error);
      showError("chatError", error.message || "Message delete nahi hua.");
    }
  }

  async function toggleReaction(message, emoji) {
    /*
      Reactions ko JSONB mein store karna concurrent updates ke liye
      safe nahi hai. Isliye ye handler bina atomic server-side function
      ke update nahi karta. Isse lost updates aur spoofed identities
      ka risk avoid hota hai.
    */
    showError(
      "chatError",
      "Reactions enable karne ke liye secure server-side reaction function configure karna hoga."
    );
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
    if (!state.roomCode) return;

    const url = new URL(location.href);
    url.searchParams.set("room", state.roomCode);

    const shareData = {
      title: "Join my NETBAND room",
      text: `NETBAND room code: ${state.roomCode}`,
      url: url.href
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(url.href);
        showError("chatError", "Room link copy ho gaya.");
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        showError("chatError", "Room link share nahi ho saka.");
      }
    }
  }

  function searchMessages(term) {
    state.searchTerm = String(term || "").toLowerCase();

    document.querySelectorAll("#chatMessages .message").forEach(element => {
      const text = element.querySelector(".message-text")?.textContent || "";
      element.classList.toggle(
        "hidden",
        !text.toLowerCase().includes(state.searchTerm)
      );
    });
  }

  async function requestLiveKitToken() {
    if (!state.client || !state.room) {
      throw new Error("Pehle room join karo.");
    }

    const { data, error } = await state.client.functions.invoke(
      CONFIG.TOKEN_FUNCTION,
      {
        body: {
          roomName: `netband-${state.room.id}`,
          participantName: state.senderName
        }
      }
    );

    if (error) throw error;

    if (!data?.token) {
      throw new Error("LiveKit token nahi mila. Edge Function check karo.");
    }

    return data.token;
  }

  async function joinCall(withVideo = false) {
    if (state.callConnecting || state.call) return;

    if (!livekitLibrary?.Room || !livekitLibrary?.createLocalTracks) {
      showError("callError", "LiveKit client load nahi hua. Page refresh karo.");
      return;
    }

    state.callConnecting = true;
    showError("callError");

    setText("callStatus", "Connecting...");

    try {
      const token = await requestLiveKitToken();

      const call = new livekitLibrary.Room({
        adaptiveStream: true,
        dynacast: true
      });

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
      $("callStatus")?.classList.add("active");

      updateParticipants();
      updateVideoGrid();
    } catch (error) {
      console.error("Join call:", error);

      if (state.call) {
        try {
          await state.call.disconnect();
        } catch {}
      }

      state.call = null;

      state.localTracks.forEach(track => track.stop());
      state.localTracks = [];

      showError(
        "callError",
        error.message || "Call connect nahi hui. Token function aur permissions check karo."
      );

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
      .on(livekitLibrary.RoomEvent.ParticipantDisconnected, () => {
        updateParticipants();
        updateVideoGrid();
      })
      .on(livekitLibrary.RoomEvent.TrackSubscribed, (track, publication, participant) => {
        attachTrack(track, participant);
      })
      .on(livekitLibrary.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        detachTrack(track, participant);
      })
      .on(livekitLibrary.RoomEvent.TrackMuted, () => {
        updateParticipants();
      })
      .on(livekitLibrary.RoomEvent.TrackUnmuted, () => {
        updateParticipants();
      })
      .on(livekitLibrary.RoomEvent.Disconnected, () => {
        setText("callStatus", "Call disconnected");
      });
  }

  function attachTrack(track, participant) {
    if (track.kind !== "video" && track.kind !== "audio") return;

    const grid = $("videoGrid");
    if (!grid) return;

    $("videoEmpty")?.remove();

    const key = participant.identity;

    let tile = grid.querySelector(
      `[data-participant="${CSS.escape(key)}"]`
    );

    if (!tile) {
      tile = document.createElement("div");
      tile.className = "video-tile";
      tile.dataset.participant = key;

      const name = document.createElement("div");
      name.className = "video-name";
      name.textContent = participant.name || participant.identity;

      tile.appendChild(name);
      grid.appendChild(tile);
    }

    const mediaElement = track.attach();

    if (mediaElement instanceof HTMLVideoElement) {
      mediaElement.autoplay = true;
      mediaElement.playsInline = true;
    }

    tile.insertBefore(mediaElement, tile.firstChild);
  }

  function detachTrack(track, participant) {
    track.detach().forEach(element => element.remove());

    const tile = $("videoGrid")?.querySelector(
      `[data-participant="${CSS.escape(participant.identity)}"]`
    );

    if (tile && !tile.querySelector("video")) {
      tile.remove();
    }

    updateVideoGrid();
  }

  function updateVideoGrid() {
    if (!state.call) return;

    const grid = $("videoGrid");
    if (!grid) return;

    const local = state.call.localParticipant;

    if (local) {
      const key = local.identity;
      let tile = grid.querySelector(
        `[data-participant="${CSS.escape(key)}"]`
      );

      if (!tile) {
        tile = document.createElement("div");
        tile.className = "video-tile";
        tile.dataset.participant = key;

        const name = document.createElement("div");
        name.className = "video-name";
        name.textContent = `${state.senderName} (You)`;

        tile.appendChild(name);
        grid.appendChild(tile);
      }

      local.videoTrackPublications.forEach(publication => {
        const track = publication.videoTrack;

        if (track && !tile.querySelector("video")) {
          const element = track.attach();
          element.autoplay = true;
          element.playsInline = true;
          element.dataset.local = "true";
          tile.insertBefore(element, tile.firstChild);
        }
      });
    }
  }

  function updateParticipants() {
    const call = state.call;
    const list = $("participantList");

    if (!list) return;

    list.replaceChildren();

    if (!call) {
      list.textContent = "No participants yet.";
      setText("participantCount", "0");
      return;
    }

    const participants = [
      call.localParticipant,
      ...call.remoteParticipants.values()
    ];

    setText("participantCount", String(participants.length));

    participants.forEach(participant => {
      const row = document.createElement("div");
      row.className = "participant";

      const avatar = document.createElement("div");
      avatar.className = "participant-avatar";
      avatar.textContent = (participant.name || participant.identity || "G")
        .slice(0, 1)
        .toUpperCase();

      const details = document.createElement("div");
      details.className = "participant-details";

      const name = document.createElement("strong");
      name.textContent = participant.name || participant.identity;

      const status = document.createElement("small");

      const mic = participant.isMicrophoneEnabled ? "Mic on" : "Mic off";
      const camera = participant.isCameraEnabled ? "Camera on" : "Camera off";

      status.textContent =
        `${participant === call.localParticipant ? "You · " : ""}${mic} · ${camera}`;

      details.append(name, status);
      row.append(avatar, details);
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
      showError("callError", error.message || "Microphone toggle fail hua.");
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
      showError("callError", error.message || "Camera toggle fail hua.");
    }
  }

  async function leaveCall() {
    const call = state.call;

    state.call = null;

    if (call) {
      try {
        await call.disconnect();
      } catch (error) {
        console.warn("Call disconnect:", error);
      }
    }

    state.localTracks.forEach(track => {
      try {
        track.stop();
      } catch {}
    });

    state.localTracks = [];

    $("joinVoiceBtn").disabled = false;
    $("joinVideoBtn").disabled = false;
    $("muteBtn").disabled = true;
    $("cameraBtn").disabled = true;
    $("leaveCallBtn").disabled = true;

    setText("muteBtn", "Mute mic");
    setText("cameraBtn", "Turn camera on");
    setText("callStatus", "Not in a call");

    $("callStatus")?.classList.remove("active");

    $("videoGrid")?.replaceChildren();

    if ($("videoGrid")) {
      const empty = document.createElement("div");
      empty.id = "videoEmpty";
      empty.className = "video-empty";
      empty.innerHTML =
        "<span>◉</span><strong>No active call</strong><small>Join voice or video to connect with room members.</small>";

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
      empty.innerHTML =
        "<span>✧</span><strong>Your conversation starts here</strong><p>Share the room code with the person you want to chat with.</p>";

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

    $("leaveBtn")?.addEventListener("click", async () => {
      if (confirm("Room chhodna hai?")) await leaveRoom();
    });

    $("joinVoiceBtn")?.addEventListener("click", () => joinCall(false));
    $("joinVideoBtn")?.addEventListener("click", () => joinCall(true));

    $("muteBtn")?.addEventListener("click", toggleMicrophone);
    $("cameraBtn")?.addEventListener("click", toggleCamera);
    $("leaveCallBtn")?.addEventListener("click", leaveCall);

    window.addEventListener("online", setNetworkStatus);
    window.addEventListener("offline", setNetworkStatus);

    window.addEventListener("pagehide", () => {
      clearInterval(state.timer);

      if (state.call) {
        state.call.disconnect();
      }
    });
  }

  async function start() {
    setNetworkStatus();
    setupEventListeners();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(error => {
        console.warn("Service worker registration failed:", error);
      });
    }

    const params = new URLSearchParams(location.search);
    const roomCode = params.get("room");

    if (roomCode) {
      $("roomInput").value = roomCode.toUpperCase();
      await joinRoom(roomCode);
    }
  }

  start();
})();
