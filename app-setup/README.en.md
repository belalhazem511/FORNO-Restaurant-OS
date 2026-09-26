# SOLO Restaurant OS for Windows

## Install

Run `SOLO-Setup-x64.exe` and follow the Windows installer. The installer is per-user; it does not require administrator access, Bun, Node.js, Git, or internet access for normal restaurant operation. First launch opens the local setup wizard. Confirm the new device-local store before SOLO creates its database. Do not choose an existing data folder as a new setup.

The database and product media are stored separately from the installation under the Windows user application-data folder. Existing `FORNO Restaurant OS` data is detected and used in place; it is never automatically moved or removed.

## Portable run

Keep `SOLO-Portable-x64.exe` and `Run-SOLO.cmd` together, then run the command file or portable executable. Portable mode still stores restaurant data in the user's application-data directory, not beside the executable.

## Backup, restore, repair, and uninstall

Use SOLO's Storage page to create a verified backup or restore after explicit confirmation. Repair or upgrade with `Repair-SOLO.cmd` beside the installer; the installer preserves user data. Uninstall from Windows Settings or `Uninstall-SOLO.cmd`. Uninstall does not delete the restaurant database, media, documents, or backups.

## Language

Choose English or العربية in the first-run wizard. The installation itself does not need internet access.
