import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Section, Row } from "../pages/Settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { fmtRelative } from "../lib/format";

type TokenRow = {
  id: string;
  label: string;
  token_prefix: string;
  scopes: "read" | "write";
  account_id: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked: boolean;
};

export function McpTokensSection({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => api.get<{ tokens: TokenRow[] }>("/api/tokens"),
  });
  const [label, setLabel] = useState("MCP");
  const [allowWrite, setAllowWrite] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>("/api/tokens", { label, scopes: allowWrite ? "write" : "read" }),
    onSuccess: (r) => {
      setMinted(r.token);
      toast("Token created — copy it now; it won’t be shown again");
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/tokens/${id}`),
    onSuccess: () => {
      toast("Token revoked");
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });

  const active = (list.data?.tokens ?? []).filter((t) => !t.revoked);

  return (
    <Section
      title="MCP / API tokens"
      description="Bearer tokens for agents (Claude Desktop, etc.) at /mcp. MCP SDK v2 (stateless Streamable HTTP). Default is read-only; opt into write tools per token."
    >
      <div className="rounded-lg border border-border divide-y divide-border">
        <Row label="Endpoint" hint="Streamable HTTP JSON-RPC">
          <code className="text-xs">/mcp</code>
        </Row>
        <Row label="Allow write tools" hint="screen_sender, create_draft, send_draft, …">
          <Switch checked={allowWrite} onCheckedChange={setAllowWrite} />
        </Row>
        <Row label="Label">
          <div className="flex gap-2 items-center">
            <Input className={compact ? "h-11 text-[16px]" : "h-8 w-40"} value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
              <Plus className="size-3.5" /> Mint
            </Button>
          </div>
        </Row>
        {minted && (
          <Row label="New token" hint="Copy now — shown once">
            <div className="flex gap-2 items-center max-w-full">
              <code className="text-[11px] truncate">{minted}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(minted);
                  toast("Copied");
                }}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          </Row>
        )}
      </div>
      {active.length > 0 && (
        <div className="mt-4 rounded-lg border border-border divide-y divide-border">
          {active.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium truncate">
                  {t.label} · <code className="text-xs">{t.token_prefix}…</code>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t.scopes} · created {fmtRelative(t.created_at)}
                  {t.last_used_at ? ` · used ${fmtRelative(t.last_used_at)}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(t.id)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
