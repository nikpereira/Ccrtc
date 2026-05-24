const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/customer/index.html')));
app.get('/agent', (req, res) => res.sendFile(path.join(__dirname, 'public/agent/index.html')));

// ── State ────────────────────────────────────────────────────────────────────
const agents = {};       // socketId -> { name, status, stats: {calls,totalDuration} }
const queue = [];        // [{ socketId, name, waitingSince }]
const activeCalls = {};  // callId -> { customerId, agentId, startTime, onHold }
const callHistory = {};  // agentId -> [{ customerName, duration, disposition, notes, time }]

function getAgentList() {
  return Object.entries(agents).map(([id, d]) => ({ id, ...d }));
}

function findAvailableAgent() {
  return Object.entries(agents).find(([, d]) => d.status === 'available')?.[0] || null;
}

function broadcastAgentState() {
  io.to('agents').emit('agent-list-updated', getAgentList());
  io.to('agents').emit('queue-updated', queue);
}

function makeAgent(name) {
  return { name, status: 'available', stats: { calls: 0, totalDuration: 0 } };
}

// ── Connections ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── AGENT ──────────────────────────────────────────────────────────────────
  socket.on('agent-join', ({ name }) => {
    socket.join('agents');
    agents[socket.id] = makeAgent(name);
    callHistory[socket.id] = [];
    console.log(`[Agent] ${name} joined`);
    broadcastAgentState();
    socket.emit('call-history', callHistory[socket.id]);
  });

  socket.on('agent-set-status', ({ status }) => {
    if (agents[socket.id]) {
      agents[socket.id].status = status;
      broadcastAgentState();
    }
  });

  socket.on('agent-accept-call', ({ customerId }) => {
    const agent = agents[socket.id];
    if (!agent || agent.status !== 'available') return;
    const idx = queue.findIndex(c => c.socketId === customerId);
    const customerName = idx !== -1 ? queue[idx].name : 'Customer';
    if (idx !== -1) queue.splice(idx, 1);

    const callId = `call-${Date.now()}`;
    agent.status = 'busy';
    activeCalls[callId] = { customerId, agentId: socket.id, startTime: Date.now(), onHold: false, customerName };

    io.to(customerId).emit('call-accepted', { callId, agentId: socket.id, agentName: agent.name });
    socket.emit('call-started', { callId, customerId, customerName });
    broadcastAgentState();
    console.log(`[Call] ${callId} started`);
  });

  // Hold toggle — server relays to customer
  socket.on('agent-hold', ({ callId, onHold }) => {
    const call = activeCalls[callId];
    if (!call) return;
    call.onHold = onHold;
    io.to(call.customerId).emit('call-hold-changed', { onHold });
    console.log(`[Hold] ${callId} onHold=${onHold}`);
  });

  // Mute status broadcast (informational, actual mute is client-side)
  socket.on('agent-mute', ({ callId, muted }) => {
    const call = activeCalls[callId];
    if (!call) return;
    io.to(call.customerId).emit('agent-mute-changed', { muted });
  });

  socket.on('customer-mute', ({ callId, muted }) => {
    const call = activeCalls[callId];
    if (!call) return;
    io.to(call.agentId).emit('customer-mute-changed', { muted });
  });

  // Transfer: agent requests transfer to another agent
  socket.on('agent-transfer', ({ callId, targetAgentId }) => {
    const call = activeCalls[callId];
    const fromAgent = agents[socket.id];
    const toAgent = agents[targetAgentId];
    if (!call || !toAgent || toAgent.status !== 'available') {
      socket.emit('transfer-failed', { reason: 'Agent unavailable' });
      return;
    }

    // Update call record
    call.agentId = targetAgentId;
    call.onHold = false;
    toAgent.status = 'busy';
    if (fromAgent) fromAgent.status = 'available';

    // Notify all parties
    io.to(call.customerId).emit('call-transferred', { agentName: toAgent.name, agentId: targetAgentId });
    io.to(targetAgentId).emit('call-started', { callId, customerId: call.customerId, customerName: call.customerName, transferred: true });
    socket.emit('transfer-complete', { callId });

    broadcastAgentState();
    console.log(`[Transfer] ${callId} → ${toAgent.name}`);
  });

  // End call with disposition + notes
  socket.on('end-call', ({ callId, disposition, notes }) => {
    const call = activeCalls[callId];
    if (!call) return;
    const duration = Math.round((Date.now() - call.startTime) / 1000);

    // Update agent stats
    const agent = agents[call.agentId];
    if (agent) {
      agent.stats.calls++;
      agent.stats.totalDuration += duration;
      agent.status = 'available';
    }

    // Save to call history
    if (callHistory[call.agentId]) {
      callHistory[call.agentId].unshift({
        customerName: call.customerName || 'Customer',
        duration,
        disposition: disposition || 'resolved',
        notes: notes || '',
        time: new Date().toISOString()
      });
      // Keep last 50
      if (callHistory[call.agentId].length > 50) callHistory[call.agentId].pop();
    }

    io.to(call.customerId).emit('call-ended', { duration });
    io.to(call.agentId).emit('call-ended', { duration, disposition, notes });
    io.to(call.agentId).emit('call-history', callHistory[call.agentId]);
    io.to(call.agentId).emit('stats-updated', agents[call.agentId]?.stats);

    delete activeCalls[callId];
    broadcastAgentState();
    console.log(`[End] ${callId} duration=${duration}s disposition=${disposition}`);
  });

  // ── CUSTOMER ───────────────────────────────────────────────────────────────
  socket.on('customer-call-request', ({ name }) => {
    const availableAgentId = findAvailableAgent();
    if (availableAgentId) {
      const callId = `call-${Date.now()}`;
      agents[availableAgentId].status = 'busy';
      activeCalls[callId] = { customerId: socket.id, agentId: availableAgentId, startTime: Date.now(), onHold: false, customerName: name };

      socket.emit('call-accepted', { callId, agentId: availableAgentId, agentName: agents[availableAgentId].name });
      io.to(availableAgentId).emit('call-started', { callId, customerId: socket.id, customerName: name });
      broadcastAgentState();
    } else {
      queue.push({ socketId: socket.id, name, waitingSince: Date.now() });
      socket.emit('call-queued', { position: queue.length, estimatedWait: queue.length * 90 });
      io.to('agents').emit('queue-updated', queue);
    }
  });

  socket.on('customer-cancel', () => {
    const idx = queue.findIndex(c => c.socketId === socket.id);
    if (idx !== -1) { queue.splice(idx, 1); broadcastAgentState(); }
  });

  // ── WebRTC relay ───────────────────────────────────────────────────────────
  socket.on('webrtc-offer',   ({ to, offer })     => io.to(to).emit('webrtc-offer',   { from: socket.id, offer }));
  socket.on('webrtc-answer',  ({ to, answer })    => io.to(to).emit('webrtc-answer',  { from: socket.id, answer }));
  socket.on('webrtc-ice',     ({ to, candidate }) => io.to(to).emit('webrtc-ice',     { from: socket.id, candidate }));

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (agents[socket.id]) {
      const agentCall = Object.entries(activeCalls).find(([, c]) => c.agentId === socket.id);
      if (agentCall) {
        const [callId, call] = agentCall;
        io.to(call.customerId).emit('call-ended', { reason: 'Agent disconnected' });
        delete activeCalls[callId];
      }
      delete agents[socket.id];
      delete callHistory[socket.id];
      broadcastAgentState();
    }
    const qIdx = queue.findIndex(c => c.socketId === socket.id);
    if (qIdx !== -1) { queue.splice(qIdx, 1); broadcastAgentState(); }

    const custCall = Object.entries(activeCalls).find(([, c]) => c.customerId === socket.id);
    if (custCall) {
      const [callId, call] = custCall;
      io.to(call.agentId).emit('call-ended', { reason: 'Customer disconnected' });
      if (agents[call.agentId]) agents[call.agentId].status = 'available';
      delete activeCalls[callId];
      broadcastAgentState();
    }
    console.log(`[-] ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🚀 http://localhost:${PORT}  |  Agent: http://localhost:${PORT}/agent\n`));
