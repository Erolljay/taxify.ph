# Deploying the "Save to Server" feature for Tax Rates

One-time server setup so the Super Admin's Tax Rates → Publish tab can
save directly to `tax-rates-data.json`, instead of copy-pasting JSON
into a GitHub PR. Only you (whoever knows the password you set below)
will be able to save.

Run all commands on `txform-server` via SSH.

## 1. Install PHP-FPM (not just the CLI — nginx needs the FPM service)

```
sudo apt install php8.5-fpm apache2-utils
```

`apache2-utils` gives you the `htpasswd` command used in step 2.

Confirm it's running:
```
sudo systemctl status php8.5-fpm
```

Confirm the socket path matches what's in the nginx snippet:
```
ls /run/php/
```
If you see a different filename than `php8.5-fpm.sock`, update
`fastcgi_pass unix:/run/php/php8.5-fpm.sock;` in step 3 to match.

## 2. Create the password file

```
sudo htpasswd -c /etc/nginx/.htpasswd-taxrates admin
```

It'll prompt you to set a password twice. `-c` **creates** the file —
only use `-c` this first time; if you ever add a second user later,
drop the `-c` or it'll overwrite the file.

## 3. Create the admin token (the second gate)

The PHP script needs a shared secret on top of the password — so that even
if the nginx password block is ever dropped by mistake, nobody can write to
your tax rates without also knowing this token. Generate one and drop it in a
file the web server can read:

```
openssl rand -hex 24 | sudo tee /etc/txform/tax-rates.token
sudo chown www-data:www-data /etc/txform/tax-rates.token
sudo chmod 640 /etc/txform/tax-rates.token
```

(`sudo mkdir -p /etc/txform` first if that folder doesn't exist yet.)

Copy the value it prints — you'll paste it into the browser **once** the first
time you click "Save to Server" (it's then remembered in that browser). Keep a
copy somewhere safe, like the same place you store the password from step 2.

Until this file exists the Save button returns *"Server not configured"* — the
Copy-JSON-to-GitHub fallback still works in the meantime, so you're never stuck.

## 4. Add the nginx location block

Open the config:
```
sudo nano /etc/nginx/sites-available/managerserver
```

Find the `server { ... }` block for `extension.txform.ph` (the one
serving `/var/www/taxify`). Paste the contents of
`nginx-tax-rates-snippet.conf` (delivered alongside this file) inside
that block, anywhere before the closing `}`.

Test and reload:
```
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` must say "syntax is ok" / "test is successful" before you
reload — if it doesn't, don't reload; fix the reported line first.

## 5. Deploy the code

`save-tax-rates.php` and the updated `tax-rates-admin.js` are part of
the normal git deploy — once merged to `main` on GitHub:
```
cd /var/www/taxify && sudo git pull
```

That's it — no separate upload step, it rides along with your usual
deploy.

## 6. Set file permissions so the script can actually write

The web server user (usually `www-data`) needs write access to the
`tax-rates.ph` directory (to create `tax-rates-backups/` and to
overwrite `tax-rates-data.json`):

```
sudo chown www-data:www-data /var/www/taxify/tax-rates-data.json
sudo chmod 664 /var/www/taxify/tax-rates-data.json
```

## 7. Test it

Open `https://extension.txform.ph/installer.html`, go to the **Tax
Rates** tab, add a rate, go to **Publish**, click **Save to Server**.
It should prompt for the username/password from step 2 (browser's
native login popup), then a one-time box for the **admin token** from
step 3, then confirm success. Both are remembered for next time.

If it fails, check:
```
sudo tail -n 50 /var/log/nginx/error.log
```
- A "permission denied" there almost always means step 6 was skipped.
- *"Server not configured: admin token missing"* means step 3 was
  skipped, or `www-data` can't read `/etc/txform/tax-rates.token`.
- *"Admin token rejected"* means the token you typed doesn't match the
  file — click Save again to re-enter it.
