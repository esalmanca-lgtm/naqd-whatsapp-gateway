# Enabling HTTP/2 on nginx for evo.naqd.in

**Goal:** Remove the browser's ~6-simultaneous-download limit so media-heavy chats
load in parallel instead of in waves. This is a server-side change only — no app code changes.

**Your setup (detected):** nginx/1.24.0 (Ubuntu), HTTPS on port 443, proxying the
Evolution API (Express). Direct nginx (no Cloudflare in front).

---

## ⚠️ Version note (important)

On **nginx 1.24.0** the correct syntax is the `http2` parameter on the `listen` line:

```nginx
listen 443 ssl http2;
```

Do **not** use the separate `http2 on;` directive — that only exists in nginx 1.25.1+.
On your 1.24.0 it would fail `nginx -t`.

---

## Steps

### 1. SSH into the VPS
```bash
ssh YOUR_USER@YOUR_VPS_IP
```

### 2. Find the config that serves evo.naqd.in
```bash
sudo grep -rl "evo.naqd.in" /etc/nginx/
```
Common locations: `/etc/nginx/sites-available/` or `/etc/nginx/conf.d/`.
To see every listen/server_name line in the live config:
```bash
sudo nginx -T | grep -nE "listen|server_name"
```

### 3. Back it up FIRST
Replace the path with whatever step 2 returned:
```bash
sudo cp /etc/nginx/sites-available/evo.naqd.in /etc/nginx/sites-available/evo.naqd.in.bak
```

### 4. Edit the HTTPS listen line
```bash
sudo nano /etc/nginx/sites-available/evo.naqd.in
```
Inside the `server { ... }` block for `evo.naqd.in`, find the port-443 lines:
```nginx
    listen 443 ssl;             # managed by Certbot
    listen [::]:443 ssl;        # managed by Certbot   (may or may not be present)
```
Add `http2`:
```nginx
    listen 443 ssl http2;       # managed by Certbot
    listen [::]:443 ssl http2;  # managed by Certbot
```
- Only touch the **443 / ssl** lines. **Leave port 80 alone.**
- Keep any `# managed by Certbot` comment — just add the word `http2`.

### 5. Test the config BEFORE applying
```bash
sudo nginx -t
```
Must report `syntax is ok` and `test is successful`.
If it errors, fix the typo or restore the backup (see Rollback) — do NOT reload.

### 6. Reload nginx (zero downtime)
```bash
sudo systemctl reload nginx
```

### 7. Verify HTTP/2 is live
From your Mac (or anywhere):
```bash
curl -I --http2 https://evo.naqd.in/ | grep -i "^HTTP"
```
- ✅ Success looks like: `HTTP/2 200` (any status code is fine — the `HTTP/2` is what matters).
- ❌ If it still says `HTTP/1.1`, HTTP/2 didn't take — recheck the listen line and that you edited the block actually serving 443.

---

## Rollback (if anything looks wrong)
```bash
sudo cp /etc/nginx/sites-available/evo.naqd.in.bak /etc/nginx/sites-available/evo.naqd.in
sudo nginx -t && sudo systemctl reload nginx
```

---

## Notes / gotchas
- HTTP/2 **requires HTTPS** — you already have it, so you're good.
- **No app changes needed.** Browsers auto-negotiate HTTP/2; anything old falls back to HTTP/1.1 automatically.
- The **Docker monitor** container (`vps-monitor`) is unrelated to this — don't change it.
- If you ever put Cloudflare in front, Cloudflare would serve HTTP/2 to browsers regardless of the origin — but as of now it's direct nginx, so this change is what matters.
- Biggest, most visible benefit: opening media-heavy chats and first app load. Quiet text-only chats won't look different.
