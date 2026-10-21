(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ==========================================
  // CONFIGURATION
  // ==========================================

  const config = {
    url: "https://frjzfmskbkcogeeqytjm.supabase.co",
    key: "sb_publishable_CIl_axgZv5JixyEKj_-d5A_xypfty-U",

    // LiveKit Cloud WebSocket URL
    livekitUrl: "wss://netband-oxhvo3gt.livekit.cloud",

    // Supabase Edge Function that issues LiveKit tokens
    tokenEndpoint:
      "https://frjzfmskbkcogeeqytjm.supabase.co/functions/v1/smooth-handler"
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

    // LiveKit
    callRoom: null,
    callConnecting: false,
    callMode: null,
    micEnabled: false,
    cameraEnabled: false,
    localIdentity: null
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
    $("onlineDot").classList.toggle("offline", !online);

    if (!state.room) return;

    if (!online) {
      $("chatStatus").textContent = "Offline · messages cannot be sent";
    } else if (!state.channel) {
      $("chatStatus").textContent = "Internet available · reconnecting";
    }
  }

  window.addEventListener("online", setNetwork);
  window.addEventListener("offline", setNetwork);

  setNetwork();

  // ==========================================
  // SUPABASE
  // ==========================================

  function backendReady() {
    if (!window.supabase?.createClient) {
      throw new Error(
        "Chat service could not load. Check your internet and refresh."
      );
    }

    if (
      !config.url.startsWith("https://") ||
      !config.key ||
      config.key === "SUPABASE_PUBLISHABLE_KEY"
    ) {
      throw new Error("Check your Supabase configuration.");
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
      (byte) => chars[byte % chars.length]
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
        const parsed = JSON.parse(text.slice(MESSAGE_PREFIX.length));

        if (parsed && typeof parsed.text === "string") {
          return {
            text: parsed.text,
            replyTo: parsed.replyTo || null
          };
        }
      } catch {
        // Malformed metadata is shown as ordinary text.
      }
    }

    return { text, replyTo: null };
  }

  // ==========================================
  // EMPTY STATE
  // ==========================================

  function showEmptyState() {
    const container = $("chatMessages");

    if (!container || container.querySelector(".message")) return;

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
  // REPLIES
  // ==========================================

  function setReplyTarget(message, text) {
    state.replyTarget = {
      id: message.id,
      text: String(text || "").slice(0, 300)
    };

    $("replyPreviewText").textContent = state.replyTarget.text;
    $("replyComposerPreview").classList.remove("hidden");
    $("messageInput").focus();
  }

  function clearReplyTarget() {
    state.replyTarget = null;

    $("replyComposerPreview").classList.add("hidden");
    $("replyPreviewText").textContent = "";
  }

  $("cancelReplyBtn").addEventListener("click", clearReplyTarget);

  // ==========================================
  // RENDER MESSAGE
  // ==========================================

  function renderMessage(message) {
    if (!message || state.seen.has(message.id)) return;

    state.seen.add(message.id);

    const container = $("chatMessages");
    const empty = container.querySelector(".empty-state");

    if (empty) empty.remove();

    const parsed = parseMessageBody(message.body);

    const div = document.createElement("article");

    div.className =
      "message" +
      (message.sender_id === state.senderId ? " mine" : "");

    div.dataset.messageId = String(message.id);

    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent =
      message.sender_id === state.senderId ? "YOU" : "ROOM MEMBER";

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

    const date = new Date(message.created_at || Date.now());

    const time = document.createElement("time");
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
      await copyText(parsed.text);

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
  // ROOM UI
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

      const remaining = Math.max(0, state.expiresAt - Date.now());

      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);

      $("expiryTitle").textContent =
        remaining > 0
          ? `Room expires in ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
          : "Room expired";

      $("expiryBar").style.width =
        `${Math.min(100, (remaining / 1800000) * 100)}%`;

      if (remaining <= 0) {
        await leaveRoom(true);

        alert("This room has expired. Create a new room to continue.");
      }
    };

    tick();
    state.timer = setInterval(tick, 1000);
  }

  // ==========================================
  // CREATE / JOIN ROOM
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
          .insert({ code: generateRoomCode() })
          .select("id,code,created_at,expires_at")
          .single();

        if (error) throw error;
        room = data;
      } else {
        const normalizedCode = roomCode.trim().toUpperCase();

        if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalizedCode)) {
          throw new Error("Enter a valid 8-character room code.");
        }

        const { data, error } = await client
          .from("rooms")
          .select("id,code,created_at,expires_at")
          .eq("code", normalizedCode)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle();

        if (error) throw error;

        if (!data) {
          throw new Error("Room not found or expired. Check the code.");
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

      if (state.callRoom) {
        await leaveCall();
      }

      if (state.channel) {
        await client.removeChannel(state.channel);
        state.channel = null;
      }

      showChat(room);

      const { data: messages, error: fetchError } = await client
        .from("messages")
        .select("id,room_id,sender_id,body,created_at")
        .eq("room_id", room.id)
        .order("created_at", { ascending: true })
        .limit(200);

      if (fetchError) throw fetchError;

      (messages || []).forEach(renderMessage);

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
          (payload) => {
            if (
              state.room &&
              payload.new &&
              payload.new.room_id === state.room.id
            ) {
              renderMessage(payload.new);
            }
          }
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            $("chatStatus").textContent = "Connected · realtime active";
          } else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT"
          ) {
            $("chatStatus").textContent = "Realtime connection error";
          } else {
            $("chatStatus").textContent =
              "Connection: " + status.toLowerCase();
          }
        });

      setNetwork();

    } catch (error) {
      showError(
        "setupError",
        error.message || "Could not connect. Check your Supabase settings."
      );
    } finally {
      state.busy = false;
      $("createBtn").disabled = false;
    }
  }

  $("createBtn").addEventListener("click", () => {
    connectRoom("", true);
  });

  $("joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    connectRoom($("roomInput").value, false);
  });

  // ==========================================
  // SEND MESSAGE
  // ==========================================

  $("messageForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    showError("chatError", "");

    const input = $("messageInput");
    const body = input.value.trim();

    if (!body || !state.room) return;

    if (!navigator.onLine) {
      showError("chatError", "You are offline. Message not sent.");
      return;
    }

    if (Date.now() >= state.expiresAt) {
      showError("chatError", "This room has expired.");
      return;
    }

    $("sendBtn").disabled = true;

    try {
      const client = backendReady();

      const { error } = await client
        .from("messages")
        .insert({
          room_id: state.room.id,
          sender_id: state.senderId,
          body: encodeMessageBody(body, state.replyTarget)
        });

      if (error) throw error;

      input.value = "";
      clearReplyTarget();

    } catch (error) {
      showError(
        "chatError",
        "Message not sent: " + (error.message || "Check your connection.")
      );
    } finally {
      $("sendBtn").disabled = false;
      input.focus();
    }
  });

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
  // LIVEKIT CALL UI
  // ==========================================

  function livekitAvailable() {
    return Boolean(
      window.LivekitClient &&
      window.LivekitClient.Room &&
      window.LivekitClient.createLocalTracks
    );
  }

  function setCallStatus(text, active = false) {
    const status = $("callStatus");

    status.textContent = text;
    status.classList.toggle("active", active);
  }

  function setCallButtons(connected) {
    $("joinVoiceBtn").disabled = connected || state.callConnecting;
    $("joinVideoBtn").disabled = connected || state.callConnecting;

    $("muteBtn").disabled = !connected;
    $("cameraBtn").disabled = !connected;
    $("leaveCallBtn").disabled = !connected;
  }

  function safeParticipantName() {
    return "Guest-" + state.senderId.slice(0, 6);
  }

  // ==========================================
  // TOKEN REQUEST
  // ==========================================

  async function requestLiveKitToken(roomName, participantName) {
    const client = backendReady();

    /*
      NOTE:
      Supabase Edge Function JWT verification may reject the
      publishable key as a bearer token.

      Do not disable authorization without adding proper server-side
      validation and abuse protection.
    */

    const { data, error } = await client.functions.invoke(
      "smooth-handler",
      {
        body: {
          roomName,
          participantName
        }
      }
    );

    if (error) {
      throw new Error(
        "Could not obtain call token. Check the smooth-handler Edge Function authorization and logs."
      );
    }

    if (!data || typeof data.token !== "string" || !data.token) {
      throw new Error(
        "The token service did not return a valid LiveKit token."
      );
    }

    return data.token;
  }

  // ==========================================
  // PARTICIPANT UI
  // ==========================================

  function participantDisplayName(participant) {
    return (
      participant.name ||
      participant.identity ||
      "Guest"
    );
  }

  function getParticipants() {
    const participants = [];

    if (state.callRoom?.localParticipant) {
      participants.push(state.callRoom.localParticipant);
    }

    if (state.callRoom?.remoteParticipants) {
      state.callRoom.remoteParticipants.forEach((participant) => {
        participants.push(participant);
      });
    }

    return participants;
  }

  function renderParticipants() {
    const container = $("participantList");
    const participants = getParticipants();

    $("participantCount").textContent = String(participants.length);

    container.replaceChildren();

    if (!participants.length) {
      const empty = document.createElement("p");
      empty.className = "muted small";
      empty.textContent = "No participants yet.";
      container.appendChild(empty);
      return;
    }

    participants.forEach((participant) => {
      const row = document.createElement("div");
      row.className = "participant";

      const avatar = document.createElement("div");
      avatar.className = "participant-avatar";

      avatar.textContent =
        participantDisplayName(participant).charAt(0).toUpperCase();

      const details = document.createElement("div");
      details.className = "participant-details";

      const name = document.createElement("strong");
      name.textContent = participantDisplayName(participant);

      const mic = participant.isMicrophoneEnabled
        ? "Mic on"
        : "Mic off";

      const camera = participant.isCameraEnabled
        ? "Camera on"
        : "Camera off";

      const info = document.createElement("small");
      info.textContent = `${mic} · ${camera}`;

      details.append(name, info);
      row.append(avatar, details);
      container.appendChild(row);
    });
  }

  // ==========================================
  // VIDEO ELEMENTS
  // ==========================================

  function getTileId(participant) {
    const raw =
      participant.identity ||
      participant.sid ||
      "participant";

    return "video-" + raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function getOrCreateTile(participant) {
    const grid = $("videoGrid");
    const tileId = getTileId(participant);

    let tile = document.getElementById(tileId);

    if (tile) return tile;

    $("videoEmpty")?.remove();

    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.id = tileId;

    const placeholder = document.createElement("div");
    placeholder.className = "video-placeholder";
    placeholder.textContent = "◉";
    placeholder.dataset.placeholder = "true";

    const name = document.createElement("div");
    name.className = "video-name";
    name.textContent = participantDisplayName(participant);

    tile.append(placeholder, name);
    grid.appendChild(tile);

    return tile;
  }

  function removeTile(participant) {
    const tile = document.getElementById(getTileId(participant));

    if (tile) tile.remove();

    if (!$("videoGrid").querySelector(".video-tile")) {
      const empty = document.createElement("div");
      empty.id = "videoEmpty";
      empty.className = "video-empty";

      const icon = document.createElement("span");
      icon.textContent = "◉";

      const title = document.createElement("strong");
      title.textContent = "No active call";

      const description = document.createElement("small");
      description.textContent =
        "Join voice or video to connect with room members.";

      empty.append(icon, title, description);
      $("videoGrid").appendChild(empty);
    }
  }

  function attachTrack(track, participant) {
    if (!track || !participant) return;

    const tile = getOrCreateTile(participant);

    if (track.kind === "video") {
      const placeholder = tile.querySelector(
        '[data-placeholder="true"]'
      );

      if (placeholder) placeholder.remove();

      let video = tile.querySelector("video");

      if (!video) {
        video = document.createElement("video");

        video.autoplay = true;
        video.playsInline = true;
        video.muted = participant === state.callRoom?.localParticipant;

        if (participant === state.callRoom?.localParticipant) {
          video.dataset.local = "true";
        }

        tile.prepend(video);
      }

      track.attach(video);

      video.play().catch(() => {
        // Some browsers require a user interaction before playback.
      });

    } else if (track.kind === "audio") {
      const audio = document.createElement("audio");

      audio.autoplay = true;
      audio.playsInline = true;

      tile.appendChild(audio);
      track.attach(audio);

      audio.play().catch(() => {
        // Browser autoplay restrictions may require interaction.
      });
    }

    renderParticipants();
  }

  function detachTrack(track) {
    if (!track) return;

    try {
      const elements = track.detach();

      elements.forEach((element) => {
        element.remove();
      });
    } catch (error) {
      console.warn("Track detach failed.");
    }
  }

  function handleTrackSubscribed(track, publication, participant) {
    attachTrack(track, participant);
    renderParticipants();
  }

  function handleTrackUnsubscribed(track, publication, participant) {
    detachTrack(track);

    if (track.kind === "video" && participant) {
      const tile = getOrCreateTile(participant);

      if (!tile.querySelector("video")) {
        let placeholder = tile.querySelector(
          '[data-placeholder="true"]'
        );

        if (!placeholder) {
          placeholder = document.createElement("div");
          placeholder.className = "video-placeholder";
          placeholder.dataset.placeholder = "true";
          placeholder.textContent = "◉";

          tile.prepend(placeholder);
        }
      }
    }

    renderParticipants();
  }

  // ==========================================
  // CONNECT TO LIVEKIT
  // ==========================================

  async function joinCall(mode) {
    if (state.callConnecting || state.callRoom) return;

    showError("callError", "");

    if (!state.room) {
      showError("callError", "Create or join a chat room first.");
      return;
    }

    if (Date.now() >= state.expiresAt) {
      showError("callError", "This room has expired.");
      return;
    }

    if (!navigator.onLine) {
      showError("callError", "Internet connection is required for calls.");
      return;
    }

    if (!livekitAvailable()) {
      showError(
        "callError",
        "LiveKit SDK did not load. Refresh the page and try again."
      );
      return;
    }

    state.callConnecting = true;
    state.callMode = mode;

    setCallButtons(false);

    $("joinVoiceBtn").disabled = true;
    $("joinVideoBtn").disabled = true;

    setCallStatus("Connecting…");

    let room;

    try {
      const participantName = safeParticipantName();
      const roomName = "netband-" + state.room.code;

      const token = await requestLiveKitToken(
        roomName,
        participantName
      );

      room = new window.LivekitClient.Room({
        adaptiveStream: true,
        dynacast: true
      });

      room.on(
        window.LivekitClient.RoomEvent.TrackSubscribed,
        handleTrackSubscribed
      );

      room.on(
        window.LivekitClient.RoomEvent.TrackUnsubscribed,
        handleTrackUnsubscribed
      );

      room.on(
        window.LivekitClient.RoomEvent.ParticipantConnected,
        () => renderParticipants()
      );

      room.on(
        window.LivekitClient.RoomEvent.ParticipantDisconnected,
        (participant) => {
          removeTile(participant);
          renderParticipants();
        }
      );

      room.on(
        window.LivekitClient.RoomEvent.LocalTrackPublished,
        (publication, participant) => {
          if (publication.track) {
            attachTrack(publication.track, participant);
          }

          renderParticipants();
        }
      );

      room.on(
        window.LivekitClient.RoomEvent.LocalTrackUnpublished,
        (publication, participant) => {
          if (publication.track) {
            detachTrack(publication.track);
          }

          renderParticipants();
        }
      );

      room.on(
        window.LivekitClient.RoomEvent.Disconnected,
        () => {
          if (state.callRoom === room) {
            state.callRoom = null;
            state.micEnabled = false;
            state.cameraEnabled = false;

            setCallButtons(false);
            setCallStatus("Disconnected");

            renderParticipants();
          }
        }
      );

      await room.connect(config.livekitUrl, token);

      state.callRoom = room;

      // Start microphone and optionally camera.
      await room.localParticipant.setMicrophoneEnabled(true);
      state.micEnabled = true;

      if (mode === "video") {
        await room.localParticipant.setCameraEnabled(true);
        state.cameraEnabled = true;
      }

      // Render existing participants already in the room.
      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((publication) => {
          if (publication.track && publication.isSubscribed) {
            attachTrack(publication.track, participant);
          }
        });
      });

      // Attach locally published tracks.
      room.localParticipant.trackPublications.forEach((publication) => {
        if (publication.track) {
          attachTrack(publication.track, room.localParticipant);
        }
      });

      setCallStatus(
        mode === "video" ? "Video call active" : "Voice call active",
        true
      );

      $("muteBtn").textContent = "Mute mic";
      $("cameraBtn").textContent = state.cameraEnabled
        ? "Turn camera off"
        : "Turn camera on";

      setCallButtons(true);
      renderParticipants();

    } catch (error) {
      console.error("LiveKit connection failed:", error);

      if (room) {
        try {
          await room.disconnect();
        } catch {
          // Ignore cleanup errors.
        }
      }

      if (state.callRoom === room) {
        state.callRoom = null;
      }

      setCallStatus("Call unavailable");

      let message =
        error?.message ||
        "Could not connect to the call.";

      if (
        /token|unauthorized|401|403|authorization/i.test(message)
      ) {
        message =
          "Call token authorization failed. Check the smooth-handler Edge Function and its logs.";
      } else if (
        /permission|device|microphone|camera|notallowed/i.test(message)
      ) {
        message =
          "Microphone or camera access failed. Allow permissions in your browser and retry.";
      }

      showError("callError", message);

    } finally {
      state.callConnecting = false;

      if (!state.callRoom) {
        $("joinVoiceBtn").disabled = false;
        $("joinVideoBtn").disabled = false;
        $("muteBtn").disabled = true;
        $("cameraBtn").disabled = true;
        $("leaveCallBtn").disabled = true;
      }
    }
  }

  // ==========================================
  // CALL BUTTONS
  // ==========================================

  $("joinVoiceBtn").addEventListener("click", () => {
    joinCall("voice");
  });

  $("joinVideoBtn").addEventListener("click", () => {
    joinCall("video");
  });

  // ==========================================
  // MICROPHONE TOGGLE
  // ==========================================

  $("muteBtn").addEventListener("click", async () => {
    const room = state.callRoom;

    if (!room) return;

    try {
      const enable = !state.micEnabled;

      await room.localParticipant.setMicrophoneEnabled(enable);

      state.micEnabled = enable;

      $("muteBtn").textContent = enable ? "Mute mic" : "Unmute mic";

      renderParticipants();

    } catch (error) {
      showError(
        "callError",
        "Could not change microphone state. Check microphone permissions."
      );
    }
  });

  // ==========================================
  // CAMERA TOGGLE
  // ==========================================

  $("cameraBtn").addEventListener("click", async () => {
    const room = state.callRoom;

    if (!room) return;

    try {
      const enable = !state.cameraEnabled;

      await room.localParticipant.setCameraEnabled(enable);

      state.cameraEnabled = enable;

      $("cameraBtn").textContent =
        enable ? "Turn camera off" : "Turn camera on";

      renderParticipants();

    } catch (error) {
      showError(
        "callError",
        "Could not change camera state. Check camera permissions."
      );
    }
  });

  // ==========================================
  // LEAVE CALL
  // ==========================================

  async function leaveCall() {
    const room = state.callRoom;

    state.callRoom = null;
    state.callMode = null;
    state.micEnabled = false;
    state.cameraEnabled = false;

    if (room) {
      try {
        await room.disconnect();
      } catch (error) {
        console.warn("Call disconnect cleanup failed.");
      }

      try {
        room.localParticipant.trackPublications.forEach((publication) => {
          if (publication.track) {
            detachTrack(publication.track);
          }
        });

        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((publication) => {
            if (publication.track) {
              detachTrack(publication.track);
            }
          });
        });
      } catch {
        // Ignore tracks already removed during disconnect.
      }
    }

    $("videoGrid").replaceChildren();

    const empty = document.createElement("div");
    empty.id = "videoEmpty";
    empty.className = "video-empty";

    const icon = document.createElement("span");
    icon.textContent = "◉";

    const title = document.createElement("strong");
    title.textContent = "No active call";

    const description = document.createElement("small");
    description.textContent =
      "Join voice or video to connect with room members.";

    empty.append(icon, title, description);
    $("videoGrid").appendChild(empty);

    $("participantList").replaceChildren();

    const emptyParticipants = document.createElement("p");
    emptyParticipants.className = "muted small";
    emptyParticipants.textContent = "No participants yet.";

    $("participantList").appendChild(emptyParticipants);
    $("participantCount").textContent = "0";

    setCallStatus("Not in a call");
    setCallButtons(false);

    $("joinVoiceBtn").disabled = false;
    $("joinVideoBtn").disabled = false;

    showError("callError", "");
  }

  $("leaveCallBtn").addEventListener("click", leaveCall);

  // ==========================================
  // LEAVE CHAT ROOM
  // ==========================================

  async function leaveRoom(expired = false) {
    clearInterval(state.timer);
    state.timer = null;

    // Leave voice/video call first.
    await leaveCall();

    if (state.channel && state.client) {
      try {
        await state.client.removeChannel(state.channel);
      } catch {
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
  // PAGE CLOSE CLEANUP
  // ==========================================

  window.addEventListener("pagehide", () => {
    try {
      state.callRoom?.disconnect();
    } catch {
      // Browser is closing.
    }
  });

  // ==========================================
  // SERVICE WORKER
  // ==========================================

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(() => {
          console.warn("Service worker registration failed.");
        });
    });
  }
})();
