# NAQD WhatsApp Response Monitor Daemon (Docker VPS Hosting)

This is a lightweight Node.js background daemon designed to run 24/7 inside a Docker container on your VPS to monitor overdue client messages and send alerts automatically.

It contains a built-in lightweight HTTP Server that **serves your Dashboard UI** and synchronizes configuration settings (e.g. timeout, target JIDs, format templates) dynamically.

## Quick Start on VPS via Git

Since this folder is part of your repository, you don't need to copy-paste scripts. Just download the repository onto your VPS and build the container:

### 1. Download the repository on VPS
SSH into your VPS and run:
```bash
git clone https://github.com/esalmanca-lgtm/naqd-whatsapp-gateway.git
cd naqd-whatsapp-gateway
```
*(If you already have the repository cloned on your VPS, just run `git pull` inside the folder to get the latest files).*

### 2. Configure variables
Create a `.env` file inside the `vps-monitor` directory to configure your credentials:
```bash
cat << 'EOF' > vps-monitor/.env
PORT=3000
API_URL=https://evo.naqd.in
API_KEY=93D6C0CFC14E-49C8-A8FC-C0300A29D250
INSTANCE=EXIM
TARGET_JID=120363411366521608@g.us
OFFICE_NUMBERS=918848159581,919380525080,919778159581,919495849582,918136849582,919495739582
TIMEOUT_MINS=10
ALERT_FORMAT=⚠️ *Unreplied Chat Alert*\n*Chat:* {name}\n*JID:* {jid}\nNo reply has been sent for over {timeout} minutes!
EOF
```

### 3. Build the Docker Image (Run from root folder)
Run this command from the **root** folder (`naqd-whatsapp-gateway`) of the repository to build the image (so Docker can copy the HTML files):
```bash
docker build -t naqd-monitor -f vps-monitor/Dockerfile .
```

### 4. Start the Container
Run this command to start the container in the background (mapping port `3000` to access the dashboard and storing compliance logs on the host VPS persistent disk):
```bash
docker run -d \
  --name naqd-monitor \
  --restart always \
  -p 4000:3000 \
  -v $(pwd)/vps-monitor/data:/app/data \
  --env-file vps-monitor/.env \
  naqd-monitor
```

> **Important:** mount the `data` **directory** (`vps-monitor/data:/app/data`), NOT a
> single file. Mounting a not-yet-existing file makes Docker create it as a *directory*,
> which silently breaks state saving (subscriptions, alert history) with `EISDIR`.

### 5. Access the UI
Open your browser and navigate to:
👉 **`http://YOUR_VPS_IP:3000`**

From this page, you can monitor chats, view late reply compliance statistics, and edit your alert configurations. All changes made in the settings will instantly sync to the background monitor process!

### 6. Check logs & verify
Verify the container is running and watch the logs:
```bash
# Stream logs
docker logs -f naqd-monitor
```
Press `Ctrl+C` to exit the live logs stream.
