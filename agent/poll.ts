type Cfg = { cloudUrl: string; secret: string };

export async function fetchTasks(cfg: Cfg): Promise<Array<{ id: string; type: string; payload: string }>> {
  const r = await fetch(`${cfg.cloudUrl}/api/agent/tasks`, {
    headers: { authorization: `Bearer ${cfg.secret}` },
  });
  if (!r.ok) throw new Error(`fetchTasks failed: ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { tasks: Array<{ id: string; type: string; payload: string }> };
  return data.tasks;
}

/**
 * Tell the cloud this agent is alive, and whether AnkiConnect answered on the last probe.
 *
 * Without this the cloud cannot distinguish "the agent has been down for a week" from "there was
 * nothing to do this week" — which is how a pipeline that had never once run successfully looked
 * exactly like a quiet week. Throws on a non-2xx so the caller can log it; a failed heartbeat must
 * never be mistaken for a successful one.
 */
export async function sendHeartbeat(cfg: Cfg, hb: { ankiReachable: boolean }): Promise<void> {
  const r = await fetch(`${cfg.cloudUrl}/api/agent/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
    body: JSON.stringify({ ankiReachable: hb.ankiReachable }),
  });
  if (!r.ok) throw new Error(`sendHeartbeat failed: ${r.status} ${await r.text()}`);
}

export async function completeTask(cfg: Cfg, id: string, result: string, ok: boolean): Promise<void> {
  const r = await fetch(`${cfg.cloudUrl}/api/agent/tasks/${id}/done`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
    body: JSON.stringify({ result, ok }),
  });
  if (!r.ok) throw new Error(`completeTask failed: ${r.status} ${await r.text()}`);
}
