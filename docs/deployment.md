# Going live: AWS server + Vercel web app + print agent at the restaurant

```
 Laptop / phone / tablet (anywhere) ──► Vercel: web app (https://copakapana.vercel.app)
                                              │
                                              ▼
                          AWS EC2: API + live updates (https://api.YOUR-DOMAIN)  ◄──►  MongoDB Atlas
                                              ▲
                                              │  outgoing secure connection (no port forwarding)
                          Restaurant PC: print agent ──USB──► bill printer
```

- Anyone with a cashier login can close or reprint a bill **from any device, anywhere**. The server sends it to the print agent, which prints it at the restaurant.
- The restaurant PC only needs to be **switched on, signed in to Windows, and online**. The agent starts by itself.
- If the restaurant PC is off or offline, bills **wait on the server** and print as soon as it's back. The billing desk shows the printer as offline in the meantime.

**What you need:** an AWS account, a free MongoDB Atlas account, a free Vercel account, a GitHub account, and a **domain name** (for example `copakapana.in`, around ₹800 a year). The domain is required because the web app on Vercel is HTTPS, and browsers block it from calling a server without HTTPS.

Times below are rough first-time estimates.

---

## Step 1 — Put the code on GitHub (10 min)

1. Create a **private** repository on github.com, e.g. `copakapana-pos`.
2. In `D:\copakapana`:
   ```
   git init
   git add .
   git commit -m "Copakapana POS"
   git branch -M main
   git remote add origin https://github.com/<you>/copakapana-pos.git
   git push -u origin main
   ```
   `.env` files and `data/` are already excluded by `.gitignore`, so secrets and your local database don't get uploaded. Before pushing, check that `git status` doesn't list any `.env` file.

## Step 2 — Database: MongoDB Atlas (10 min)

1. cloud.mongodb.com → **Create** a cluster. M0 (free) is enough to start, M10 for production with automatic backups. Pick the **Mumbai (ap-south-1)** region.
2. **Database Access** → add a user with a strong password.
3. **Network Access** → add your EC2 server's IP (from Step 3). Allow `0.0.0.0/0` only temporarily while testing.
4. **Connect → Drivers** → copy the connection string, e.g.
   `mongodb+srv://pos:<password>@cluster0.xxxxx.mongodb.net/kotdb?retryWrites=true&w=majority`

## Step 3 — Server on AWS EC2 (30–45 min)

1. **Launch the server:** EC2 → Launch instance → *Ubuntu 24.04 LTS*, size **t3.small**, region **Mumbai (ap-south-1)**, create a key pair (download the `.pem` file).
   Security group:
   - SSH (22) from *My IP*
   - HTTP (80) from anywhere
   - HTTPS (443) from anywhere
2. **Give it a fixed IP:** EC2 → *Elastic IPs* → Allocate → Associate with the instance.
3. **Point a domain at it:** at your domain registrar, add an **A record**: `api` → the Elastic IP. Wait until `ping api.YOUR-DOMAIN` shows that IP.
4. **Connect and install the basics:**
   ```
   ssh -i copakapana.pem ubuntu@api.YOUR-DOMAIN
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs nginx git
   sudo npm install -g pm2
   ```
5. **Get the code and build the server:**
   ```
   git clone https://github.com/<you>/copakapana-pos.git
   cd copakapana/server
   npm ci
   npm run build
   ```
6. **Create the production settings:** `nano .env` and paste the following, filling in your values. Make each secret with `openssl rand -hex 32`.
   ```
   PORT=5000
   NODE_ENV=production
   TRUST_PROXY=true
   MONGO_URI=<Atlas connection string from Step 2>
   JWT_SECRET=<openssl rand -hex 32>
   JWT_REFRESH_SECRET=<openssl rand -hex 32>
   JWT_EXPIRES_IN=15m
   JWT_REFRESH_EXPIRES_IN=7d
   AGENT_TOKEN=<openssl rand -hex 32>        # the print agent uses this too
   CORS_ORIGINS=https://copakapana.vercel.app   # your Vercel URL (Step 4); comma-separate several
   SEED_OWNER_NAME=owner
   SEED_OWNER_PASSWORD=<a strong password>   # the owner account created on first start
   ```
7. **Start it and keep it running across reboots:**
   ```
   pm2 start dist/server.js --name copakapana-api
   pm2 save
   pm2 startup        # run the command it prints
   ```
8. **HTTPS and live updates through Nginx:** run `sudo nano /etc/nginx/sites-available/copakapana`:
   ```
   server {
     server_name api.YOUR-DOMAIN;
     location / {
       proxy_pass http://127.0.0.1:5000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;     # needed for live updates (Socket.IO)
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 3600s;                    # keep station screens / agent connected
     }
   }
   ```
   Then enable it and get a free certificate:
   ```
   sudo ln -s /etc/nginx/sites-available/copakapana /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo apt-get install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d api.YOUR-DOMAIN
   ```
9. **Check:** open `https://api.YOUR-DOMAIN/health` in a browser. It should show `"status":"ok"` and `"mongoState":"connected"`.

**Updating the server later:**
```
cd ~/copakapana && git pull && cd server && MONGOMS_DISABLE_POSTINSTALL=1 npm ci && npm run build && pm2 restart copakapana-api
```

## Step 4 — Web app on Vercel (10 min)

1. vercel.com → **Add New → Project** → import the GitHub repository.
2. **Root Directory:** `client`. Framework preset: *Other*. `client/vercel.json` already sets the build command and output folder.
3. **Environment Variables:** `API_URL` = `https://api.YOUR-DOMAIN` (no trailing slash).
4. **Deploy.** You get a URL like `https://copakapana.vercel.app`. You can also add your own domain, e.g. `pos.YOUR-DOMAIN`.
5. If that URL differs from what you put in `CORS_ORIGINS` (Step 3.6), update it on the server: `nano ~/copakapana/server/.env`, then `pm2 restart copakapana-api`.
6. Open the Vercel URL → **Counter & office sign-in** → `owner` with the `SEED_OWNER_PASSWORD`. **Change that password straight away** under Staff & screens.

Every `git push` to `main` redeploys the web app automatically.

## Step 5 — Print agent on the restaurant PC (20 min)

What changes on that PC: **Node.js is installed** (needed to run the agent), the `print-agent` folder is copied, and **one startup task** is added for the signed-in user. The existing system, the printer, its driver and its settings are **not touched**. Bills from this system join the printer's normal queue alongside the existing software's prints.

1. Install **Node.js LTS** from nodejs.org (Windows installer, default options).
2. Copy the `print-agent` folder to e.g. `C:\copakapana\print-agent`, either from a USB stick or with `git clone` (you only need that folder). Then open **Command Prompt** there:
   ```
   cd C:\copakapana\print-agent
   npm ci
   ```
3. **Find the printer's exact name:**
   ```
   npm run list-printers
   ```
   It shows lines like `printer:POS-80C`. Use the receipt printer's line exactly as shown.
4. **Print a test bill directly** (no server needed):
   ```
   npm run test-print -- "printer:POS-80C"
   ```
   A sample bill marked *TEST PRINT* should come out.
5. **Connect it to the server:** create `C:\copakapana\print-agent\.env` containing:
   ```
   SERVER_URL=https://api.YOUR-DOMAIN
   AGENT_TOKEN=<the same AGENT_TOKEN as on the server>
   ```
6. **Start automatically with Windows:** double-click **`install-startup.bat`**. It builds the agent, adds the startup task and starts it now (minimised as *Copakapana Print Agent*). If it ever crashes it restarts by itself. To remove it later, run `uninstall-startup.bat`.
7. In the web app: **Settings → Bill printer → Printer address** = `printer:POS-80C` (the name from step 3) → **Save** → **Test print**. The status badge should read **Agent online**.

## Step 6 — Final check from anywhere

1. On your phone, **turn off WiFi** (use mobile data) and open the Vercel URL.
2. Sign in as a cashier, take a test order (or use *Take orders*), then go to **Billing desk → Generate & print bill** (the bill prints), then **Settle & save**.
3. The bill prints at the restaurant within a few seconds.
4. On the billing desk, the **Printer** chip at the top is green while the agent is connected.

## Kitchen screens and waiter phones

They simply open the Vercel URL: `/login/kitchen` on each station tablet, the normal sign-in on waiter phones. They work from the restaurant WiFi or mobile data alike.

## Good to know

- **Restaurant PC off or offline:** bills are kept and print automatically when it reconnects. The billing desk shows *Printer offline*, and failed prints can be reprinted with one click.
- **Backups:** use an Atlas **M10** or higher cluster for daily backups, as the PRD requires.
- **Cost guide:** EC2 t3.small ≈ US$15/month, Atlas M10 ≈ US$57/month (M0 free while testing), Vercel free (Hobby) to start, domain ≈ ₹800/year.
- **If `printer:<name>` prints garbled text or nothing:** some printer drivers don't accept raw data. Install the maker's ESC/POS driver, or add the printer a second time as **Generic / Text Only** on the same USB port and use that name. Adding a second printer entry leaves the existing one, and the existing software, unchanged.
