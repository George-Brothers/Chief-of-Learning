type Cfg = { cloudUrl: string; secret: string };

export async function fetchTasks(cfg: Cfg): Promise<Array<{ id: string; type: string; payload: string }>> {
  const r = await fetch(`${cfg.cloudUrl}/api/agent/tasks`, {
    headers: { authorization: `Bearer ${cfg.secret}` },
  });
  if (!r.ok) throw new Error(`fetchTasks failed: ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { tasks: Array<{ id: string; type: string; payload: string }> };
  return data.tasks;
}

export async function completeTask(cfg: Cfg, id: string, result: string, ok: boolean): Promise<void> {
  const r = await fetch(`${cfg.cloudUrl}/api/agent/tasks/${id}/done`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
    body: JSON.stringify({ result, ok }),
  });
  if (!r.ok) throw new Error(`completeTask failed: ${r.status} ${await r.text()}`);
}
