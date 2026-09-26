# SOLO maintenance kit

This source-controlled folder is the maintenance/developer kit. Open the repository in an editor, apply a reviewed source fix, then run `Build-SOLO.ps1` from Windows PowerShell. It builds the web app with the repository's isolated temporary PGLite/media build setup, then creates the Windows x64 installer and portable executable under the root `release` directory.

The packaging process does not open the installed user's application-data directory. Restaurant data is not part of build output and is never overwritten by rebuilding or reinstalling. To develop, install Bun 1.3.5 as a developer tool and use the repository's `bun run desktop:dev`; normal restaurant installation does not require Bun, Node.js, Git, or internet access.

Generated installers are distributables and are intentionally not checked into normal Git history.
