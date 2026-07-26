import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

const SCHEDULE_API_URL = 'https://api.npoint.io/79a6e300f4fe3e509658';
const PORT = 3000;

interface ScheduleState {
  schedule: Record<string, string>;
  lastUpdated: string;
}

let state: ScheduleState = {
  schedule: {},
  lastUpdated: new Date().toISOString(),
};

// Store SSE connections
const sseClients = new Set<express.Response>();

function broadcastUpdate() {
  const data = JSON.stringify({
    type: 'update',
    schedule: state.schedule,
    lastUpdated: state.lastUpdated,
  });

  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Initial fetch from npoint.io
async function syncFromNpoint() {
  try {
    const res = await fetch(`${SCHEDULE_API_URL}?_t=${Date.now()}`);
    if (res.ok) {
      const remoteData = await res.json();
      if (remoteData && typeof remoteData === 'object') {
        const remoteSchedule: Record<string, string> = {};
        for (const [k, v] of Object.entries(remoteData)) {
          if (typeof v === 'string') {
            remoteSchedule[k] = v;
          }
        }
        
        // If state changed, update local state & broadcast
        const currentJson = JSON.stringify(state.schedule);
        const remoteJson = JSON.stringify(remoteSchedule);
        if (currentJson !== remoteJson) {
          state = {
            schedule: remoteSchedule,
            lastUpdated: new Date().toISOString(),
          };
          broadcastUpdate();
        }
      }
    }
  } catch (err) {
    console.warn('Failed to sync from npoint.io:', err);
  }
}

// Post state to npoint.io in background
async function syncToNpoint(newSchedule: Record<string, string>) {
  try {
    await fetch(SCHEDULE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSchedule),
    });
  } catch (err) {
    console.warn('Failed to push update to npoint.io:', err);
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // Fetch initial data
  await syncFromNpoint();

  // Periodically check npoint.io every 5 seconds for changes made by other clients or direct API calls
  setInterval(syncFromNpoint, 5000);

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Get current schedule and last update timestamp
  app.get('/api/schedule', (_req, res) => {
    res.json(state);
  });

  // Update schedule
  app.post('/api/schedule', (req, res) => {
    const { dateKey, person, fullSchedule } = req.body;

    let updatedSchedule: Record<string, string> = { ...state.schedule };

    if (fullSchedule && typeof fullSchedule === 'object') {
      updatedSchedule = { ...fullSchedule };
    } else if (dateKey) {
      if (person) {
        updatedSchedule[dateKey] = person;
      } else {
        delete updatedSchedule[dateKey];
      }
    }

    state = {
      schedule: updatedSchedule,
      lastUpdated: new Date().toISOString(),
    };

    // Broadcast to all active clients instantly
    broadcastUpdate();

    // Persist to remote cloud storage (npoint.io)
    syncToNpoint(updatedSchedule);

    res.json({ success: true, ...state });
  });

  // Real-time updates stream via SSE
  app.get('/api/schedule/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial payload
    res.write(
      `data: ${JSON.stringify({
        type: 'initial',
        schedule: state.schedule,
        lastUpdated: state.lastUpdated,
      })}\n\n`
    );

    sseClients.add(res);

    // Keep connection alive with heartbeats
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // Serve with Vite in dev mode or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
