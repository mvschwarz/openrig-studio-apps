# Startup context: getting your bearings

1. `rig whoami --json`: confirm who and where you are, and which rig is yours.
2. Read your rig's own startup context (it follows this one): it says which apps this rig has and
   where they are.
3. `rig ps --nodes --json`: what is running on this machine, and what needs attention.
4. `rig context list`: the know-how on this machine. Your rig's context says which entries to make
   sure are there.
5. A reminder to yourself, for checking in regularly. A periodic reminder needs a small spec file
   naming you and the message:

   ```yaml
   target:
     session: <your session from rig whoami>
   message: "Check in: your rig, its apps and what needs attention."
   ```

   then `rig watchdog register --policy periodic-reminder --spec <file> --target-session <you>
   --interval-seconds 1800 --registered-by <you>`. Check `rig watchdog register --help` first.

What you may do on this machine is what its owner has actually enabled here.
