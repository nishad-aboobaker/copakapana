# Bill printer setup — USB printer on the existing billing PC

The receipt printer is plugged into **DESKTOP-HT9KF41** (192.168.220.35) by USB, and that PC already runs the restaurant's existing system. These steps are written so **nothing on that PC changes in a way the existing system can notice**, and every step can be undone.

## What stays exactly as it is on the desktop

- The existing billing software, and how it prints. It keeps printing as before.
- The printer's name, driver, settings and "default printer" choice.
- Existing Windows accounts and passwords, including how people sign in to that PC.
- No software is installed, nothing is uninstalled, and no restart is needed.

## What changes (three small, reversible things)

| Change | Why | Effect on the existing system |
|---|---|---|
| The printer gets a **share name** | So the laptop can send bills to it | None. Its own print jobs and ours wait in the same Windows print queue, one after another. |
| **File and printer sharing** is turned on for the network that PC already uses | So the share can be reached over the LAN | None for its programs. Windows allows file/printer sharing connections from the local network. |
| A **new, separate Windows account** just for printing (e.g. `printer`) | Windows needs a password to accept network printing; this avoids touching anyone's existing login | None. Nobody needs to use it on that PC, and it doesn't appear in the existing software. |

> Skip the new account if the PC's existing account **already has a password** and you're happy to use it from the laptop.

---

## A. On the desktop (about 5 minutes)

**Before you start:** take a photo of the printer's *Sharing* tab and of the *Advanced sharing settings* page, so you can see what they were.

1. **Share the printer** (doesn't touch the driver or the name):
   Control Panel → **Devices and Printers** → right-click the receipt printer → **Printer properties** → **Sharing** tab → tick **Share this printer** → Share name: **POS80** → **OK**.
   *Don't change anything on the other tabs.*

2. **Allow sharing on the current network only:**
   Control Panel → **Network and Sharing Center** → **Change advanced sharing settings**.
   - Find the profile marked **(current profile)**, either *Private* or *Public*.
   - Under that profile only, turn on **File and printer sharing** → **Save changes**.
   - Leave *Network discovery*, the network profile itself and everything else as they are. The laptop connects by IP address, so discovery isn't needed.

3. **Create the printing account** (skip if using an existing account with a password):
   Settings → **Accounts** → **Other users** → **Add account** → *I don't have this person's sign-in information* → *Add a user without a Microsoft account* → username **printer**, a password you'll remember → **Finish**.
   Leave it as a **Standard user** (not administrator).

4. **Check the existing system still prints:** print one bill or receipt from the existing billing software as usual.

## B. On the laptop

5. **Check the desktop accepts connections:**
   ```
   Test-NetConnection 192.168.220.35 -Port 445
   ```
   `TcpTestSucceeded : True` means step 2 worked.

6. **Sign in to the share once:** in File Explorer's address bar type `\\192.168.220.35` → enter username `DESKTOP-HT9KF41\printer` and its password → tick **Remember my credentials**. You should see **POS80**.

7. **Print a test bill** (no server or login needed):
   ```
   cd D:\copakapana\print-agent
   npm run test-print -- "\\192.168.220.35\POS80"
   ```
   A sample bill marked *TEST PRINT* should come out.

8. **Connect the system:** run `start-agent.bat` on the laptop. In the app, set **Settings → Bill printer → Printer address** to `\\192.168.220.35\POS80` → **Save** → **Test print**.

> The desktop's IP must stay the same. If the router ever gives it a new IP, use `\\DESKTOP-HT9KF41\POS80` instead, or ask whoever manages the router to reserve 192.168.220.35 for that PC.

## Undo (puts the desktop back exactly as before)

1. Printer properties → **Sharing** → untick **Share this printer**.
2. Advanced sharing settings → current profile → turn **File and printer sharing** back to how it was in your photo.
3. Settings → Accounts → Other users → **printer** → **Remove**.
4. On the laptop: Control Panel → **Credential Manager** → Windows Credentials → remove the `192.168.220.35` entry.

## Notes

- The laptop must be on, with `start-agent.bat` running, for bills from this system to print. Running the agent on the desktop would remove that dependency, but it means installing Node.js there, so it's deliberately not part of these steps.
- If the existing software and this system print at the same moment, Windows prints them one after the other. Neither is lost.

---

## Alternative: plug the printer into the laptop

Simplest setup: no changes on the desktop at all. **While it's on the laptop, the existing system on the desktop can't print**, so do this outside service or only once you've switched over.

1. Plug the printer into the laptop by USB and switch it on. Windows usually installs it automatically; otherwise install the maker's driver, or add it as **Generic / Text Only** on its USB port.
2. Devices and Printers → right-click the printer → **Printer properties** → **Sharing** → tick **Share this printer** → name **POS80**. The agent reaches it as `\\localhost\POS80`, which stays inside the laptop; no network or firewall changes are needed.
3. Test: `cd D:\copakapana\print-agent` then `npm run test-print -- "\\localhost\POS80"`.
4. Run `start-agent.bat`, set **Settings → Bill printer → Printer address** to `\\localhost\POS80`, **Save**, then **Test print**.

To go back, unplug it and plug it into the desktop again; the desktop's existing setup is unchanged.
