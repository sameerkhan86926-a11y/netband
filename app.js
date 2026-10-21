(() => {
  const $ = (id) => document.getElementById(id);
  const state = { client: null, room: null, channel: null, timer: null, expiresAt: null, seen: new Set(), senderId: getSenderId() };
  const config = {
    url: localStorage.getItem('netband_supabase_url') || '',
    key: localStorage.getItem('netband_supabase_key') || ''
  };
  $('supabaseUrl').value = config.url;
  $('supabaseKey').value = config.key;

  function getSenderId() {
    let id = sessionStorage.getItem('netband_sender_id');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('netband_sender_id', id); }
    return id;
  }
  function setNetwork() {
    const online = navigator.onLine;
    $('networkLabel').textContent = online ? 'Internet available' : 'Offline';
    $('onlineDot').classList.toggle('online', online);
    if (state.room) $('chatStatus').textContent = online ? (state.channel ? 'Connected to room' : 'Internet available • reconnecting') : 'Offline • messages cannot reach other devices';
  }
  window.addEventListener('online', setNetwork);
  window.addEventListener('offline', setNetwork);
  setNetwork();

  function backendReady() {
    if (!window.supabase || !window.supabase.createClient) throw new Error('Chat library could not load. Refresh the page and try again.');
    if (!config.url || !config.key) throw new Error('First open “Backend setup” and save your Supabase Project URL and publishable/anon key.');
    if (!state.client) state.client = window.supabase.createClient(config.url, config.key);
    return state.client;
  }
  $('saveConfigBtn').addEventListener('click', () => {
    const url = $('supabaseUrl').value.trim().replace(/\/$/, '');
    const key = $('supabaseKey').value.trim();
    if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(url) || !key) {
      $('configStatus').textContent = 'Enter a valid https:// project URL and publishable/anon key.';
      return;
    }
    config.url = url; config.key = key;
    localStorage.setItem('netband_supabase_url', url);
    localStorage.setItem('netband_supabase_key', key);
    state.client = null;
    $('configStatus').textContent = 'Settings saved in this browser. Try creating a room.';
  });

  function code() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }
  function showError(id, text) { $(id).textContent = text || ''; }
  function escapeText(text) { return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function renderMessage(msg) {
    if (!msg || state.seen.has(msg.id)) return;
    state.seen.add(msg.id);
    const empty = $('chatMessages').querySelector('.empty-state');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'message' + (msg.sender_id === state.senderId ? ' mine' : '');
    const date = new Date(msg.created_at || Date.now());
    div.innerHTML = `<div class="sender">${msg.sender_id === state.senderId ? 'YOU' : 'ROOM MEMBER'}</div><div class="body">${escapeText(msg.body)}</div><time>${date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time>`;
    $('chatMessages').appendChild(div);
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  }
  function showChat(room) {
    state.room = room;
    state.expiresAt = new Date(room.expires_at).getTime();
    $('setupPanel').classList.add('hidden');
    $('chatPanel').classList.remove('hidden');
    $('roomCodeDisplay').textContent = room.code;
    $('chatTitle').textContent = 'Temporary room';
    $('chatMessages').innerHTML = '<div class="empty-state"><span>✧</span><strong>Your conversation starts here</strong><p>Share the room code with the person you want to chat with.</p></div>';
    state.seen.clear();
    startTimer();
    $('chatStatus').textContent = 'Connecting…';
  }
  function startTimer() {
    clearInterval(state.timer);
    const tick = async () => {
      const left = Math.max(0, state.expiresAt - Date.now());
      const mins = Math.floor(left / 60000), secs = Math.floor(left % 60000 / 1000);
      $('expiryTitle').textContent = left ? `Room expires in ${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}` : 'Room expired';
      $('expiryBar').style.width = `${Math.max(0, left / 1800000 * 100)}%`;
      if (left <= 0) {
        clearInterval(state.timer);
        await leaveRoom(true);
        alert('This room has expired. Create a new room to continue.');
      }
    };
    tick(); state.timer = setInterval(tick, 1000);
  }
  async function connectRoom(roomCode, createNew) {
    showError('setupError', '');
    try {
      const client = backendReady();
      $('createBtn').disabled = true;
      const now = Date.now();
      let room;
      if (createNew) {
        const newCode = code();
        const { data, error } = await client.from('rooms').insert({ code: newCode }).select('id,code,created_at,expires_at').single();
        if (error) throw error;
        room = data;
      } else {
        const normalized = roomCode.trim().toUpperCase();
        const { data, error } = await client.from('rooms').select('id,code,created_at,expires_at').eq('code', normalized).gt('expires_at', new Date(now).toISOString()).maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Room not found or expired. Check the code and try again.');
        room = data;
      }
      if (new Date(room.expires_at).getTime() <= Date.now()) throw new Error('This room has expired. Create a new one.');
      showChat(room);
      const { data: oldMessages, error: fetchError } = await client.from('messages').select('id,room_id,sender_id,body,created_at').eq('room_id', room.id).order('created_at', {ascending:true}).limit(200);
      if (fetchError) throw fetchError;
      (oldMessages || []).forEach(renderMessage);
      state.channel = client.channel('room-' + room.id)
        .on('postgres_changes', {event:'INSERT', schema:'public', table:'messages', filter:'room_id=eq.' + room.id}, payload => {
          if (payload.new && payload.new.room_id === room.id) renderMessage(payload.new);
        })
        .subscribe(status => {
          $('chatStatus').textContent = status === 'SUBSCRIBED' ? 'Connected • realtime active' : 'Connection: ' + status.toLowerCase();
        });
      setNetwork();
    } catch (e) {
      showError('setupError', e.message || 'Could not connect. Check backend setup and SQL policies.');
      $('configStatus').textContent = 'If settings are correct, check the SQL setup and Realtime configuration.';
      if (state.room) { $('chatPanel').classList.add('hidden'); $('setupPanel').classList.remove('hidden'); state.room = null; }
    } finally { $('createBtn').disabled = false; }
  }
  $('createBtn').addEventListener('click', () => connectRoom('', true));
  $('joinForm').addEventListener('submit', e => { e.preventDefault(); connectRoom($('roomInput').value, false); });
  $('messageForm').addEventListener('submit', async e => {
    e.preventDefault();
    showError('chatError', '');
    const body = $('messageInput').value.trim();
    if (!body || !state.room) return;
    if (!navigator.onLine) { showError('chatError', 'You are offline. This message has not been sent. Reconnect and send it again.'); return; }
    if (Date.now() >= state.expiresAt) { showError('chatError', 'This room has expired.'); return; }
    try {
      const { error } = await backendReady().from('messages').insert({ room_id: state.room.id, sender_id: state.senderId, body });
      if (error) throw error;
      $('messageInput').value = '';
    } catch (e2) { showError('chatError', 'Message not sent: ' + (e2.message || 'check connection')); }
  });
  $('copyCodeBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.room.code); $('copyCodeBtn').textContent = 'Copied!'; }
    catch (_) { prompt('Copy this room code:', state.room.code); }
  });
  async function leaveRoom(expired = false) {
    clearInterval(state.timer);
    if (state.channel && state.client) await state.client.removeChannel(state.channel);
    state.channel = null; state.room = null;
    $('chatPanel').classList.add('hidden');
    $('setupPanel').classList.remove('hidden');
    if (expired) $('setupError').textContent = 'Room expired. Create a new room to chat.';
  }
  $('leaveBtn').addEventListener('click', () => leaveRoom(false));
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
})();