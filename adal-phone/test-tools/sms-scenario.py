# The LMIS-SMS scenarios on an emulator (see README.md). Run with the harness (adal-keep-backend/scripts/sms-e2e-harness.mjs) listening.
import subprocess, time, json, urllib.request, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {'ANDROID_ADB_SERVER_PORT':'15037','PATH':'/home/abduhabibi/Android/Sdk/platform-tools:/usr/bin:/bin'}
import os; env = dict(os.environ, **ENV)
def sh(c, t=60): return subprocess.run(c, shell=True, env=env, capture_output=True, text=True, timeout=t).stdout.strip()
def state(): return json.load(urllib.request.urlopen('http://127.0.0.1:18090/state'))
def post(p): return json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18090'+p, method='POST', data=b'{}', headers={'content-type':'application/json'})))
def prefs(on, acct): sh(f'{HERE}/setprefs.sh {on} "{acct}"', 90)
OFFSET = 0.99   # the emulator's clock is this far behind this PC's
def sms(frm, text, slot=0):
    out = sh(f"{HERE}/sendsms.sh '{frm}' '{text}' {slot}")
    t = float(out.split()[-1]) / 1000 + OFFSET if out.startswith('sent') or 'sent' in out else time.time()
    return t, t
def wait_for(pred, secs=15):
    t = time.time()
    while time.time()-t < secs:
        s = state()
        if pred(s): return s
        time.sleep(0.25)
    return state()
def ev(s, what): return [e for e in s['events'] if e['what']==what]
def rel(e, t): return f"{(e['t']/1000 - t):.2f}s"
def run(name, fn):
    print(f'\n=== {name}'); post('/reset'); 
    try: fn()
    except Exception as e: print('  ERROR', e)

def lmis_one():
    t0, t1 = sms('LMIS', 'Your LMIS verification code is 628391. Do not share it.')
    s = wait_for(lambda s: ev(s,'typed'))
    a = ev(s,'phone call arrived'); ty = ev(s,'typed')
    print('  call to PC:', rel(a[0], t1) if a else 'NONE', 'after the SMS command returned; typed+pressed:', rel(ty[0], t1) if ty else 'NONE')
    print('  A:', s['typed']['A'], ' B:', s['typed']['B'], ' account sent:', a[0].get('account') if a else None)
def two_waiting():
    prefs('on', '1:nuzla · 0911000000 | 2:ZAD · 0922000000')
    post('/reset')
    t0, t1 = sms('LMIS', 'LMIS code 111222', 0); s = wait_for(lambda s: ev(s,'typed'))
    t2, t3 = sms('LMIS', 'LMIS code 333444', 1); s = wait_for(lambda s: len(ev(s,'typed'))>=2)
    print('  SIM1 code 111222 and SIM2 code 333444 while both PCs wait ->', 'A:', s['typed']['A']['value'], ' B:', s['typed']['B']['value'])
    for e in ev(s,'phone call arrived'): print('   call', e['code'], 'sim', e['sim'], 'at +%.2fs'%(e['t']/1000-t1 if e['code']=='111222' else e['t']/1000-t3))
def non_lmis():
    prefs('on', 'nuzla · 0911000000'); post('/reset')
    sms('BANK', 'Your verification code is 556677'); sms('+251911223344', 'Hello, are you free tonight? 1234 is my number'); sms('LMIS', 'Your LMIS account was updated, thank you')
    time.sleep(6); s = state()
    print('  calls to the PC for: a bank code, a friend, an LMIS text with no code ->', len(ev(s,'phone call arrived')), '(0 = nothing read further, nothing sent)')
    t0, t1 = sms('Labour Market', 'Code 998877 for the e-LMIS'); s = wait_for(lambda s: ev(s,'typed'))
    print('  but a message that names LMIS in its text is taken:', [e['code'] for e in ev(s,'phone call arrived')])
def twice():
    sms('LMIS', 'LMIS code 246810'); wait_for(lambda s: ev(s,'typed'))
    sms('LMIS', 'LMIS code 246810'); time.sleep(5); s = state()
    print('  PC answers:', [e for e in ev(s,'PC answered')], ' typed pressed times:', s['typed']['A']['pressed'])
def off_and_perm():
    prefs('off', 'nuzla · 0911000000'); post('/reset'); sms('LMIS', 'LMIS code 135790'); time.sleep(5)
    print('  switch OFF ->', len(ev(state(),'phone call arrived')), 'calls (0 expected)')
    prefs('on', 'nuzla · 0911000000'); post('/reset'); sh('adb shell pm revoke com.adalkeep.phone android.permission.RECEIVE_SMS'); sms('LMIS', 'LMIS code 975310'); time.sleep(5)
    print('  permission revoked ->', len(ev(state(),'phone call arrived')), 'calls (0 expected)')
    sh('adb shell pm grant com.adalkeep.phone android.permission.RECEIVE_SMS'); post('/reset'); sh('adb shell am start -n com.adalkeep.phone/.MainActivity'); time.sleep(4)
    t0,t1 = sms('LMIS', 'LMIS code 864209'); s = wait_for(lambda s: ev(s,'typed')); print('  permission granted again ->', [e['code'] for e in ev(s,'phone call arrived')])
def asleep():
    sh('adb shell input keyevent KEYCODE_SLEEP'); sh('adb shell dumpsys deviceidle force-idle'); time.sleep(3)
    print('  idle state:', sh('adb shell dumpsys deviceidle get deep'), '| screen:', sh("adb shell dumpsys power | grep -m1 mWakefulness"))
    t0,t1 = sms('LMIS', 'LMIS code 424242'); s = wait_for(lambda s: ev(s,'typed'), 30)
    a = ev(s,'phone call arrived'); ty = ev(s,'typed')
    print('  phone asleep + deep doze: call', rel(a[0],t1) if a else 'NONE', ' typed', rel(ty[0],t1) if ty else 'NONE')
    sh('adb shell dumpsys deviceidle unforce'); sh('adb shell input keyevent KEYCODE_WAKEUP')
def closed():
    sh('adb shell input keyevent KEYCODE_HOME'); sh('adb shell am kill com.adalkeep.phone'); time.sleep(2)
    print('  process after "am kill" (app swiped / killed in the background):', sh('adb shell pidof com.adalkeep.phone') or 'not running')
    t0,t1 = sms('LMIS', 'LMIS code 707070'); s = wait_for(lambda s: ev(s,'typed'), 30)
    a = ev(s,'phone call arrived'); print('  killed in the background -> call', rel(a[0],t1) if a else 'NONE', ' typed', rel(ev(s,'typed')[0],t1) if ev(s,'typed') else 'NONE')
    post('/reset'); sh('adb shell am force-stop com.adalkeep.phone'); time.sleep(2)
    t0,t1 = sms('LMIS', 'LMIS code 808080'); time.sleep(8); s = state()
    print('  force-stopped (Settings > Force stop) -> calls:', len(ev(s,'phone call arrived')), '(Android does not wake a force-stopped app until it is opened once)')
    sh('adb shell am start -n com.adalkeep.phone/.MainActivity'); time.sleep(4); post('/reset')
    t0,t1 = sms('LMIS', 'LMIS code 909090'); s = wait_for(lambda s: ev(s,'typed')); print('  after the app is opened once again ->', [e['code'] for e in ev(s,'phone call arrived')])
def nobody_waiting():
    post('/arm/'); post('/reset'); post('/arm/')   # no PC has a code box open
    t0,t1 = sms('LMIS', 'LMIS code 313131'); time.sleep(6); s = state()
    print('  no LMIS tab waiting -> typed:', s['typed']['A']['value'] or '-', s['typed']['B']['value'] or '-', ' codes kept for every PC\'s tray:', s['codes'])
    post('/arm/AB')
which = sys.argv[1:] or ['one','two','non','twice','off','asleep','closed','nobody']
prefs('on', 'nuzla · 0911000000')
T = {'one':('1 LMIS SMS, switch on, one PC waiting', lmis_one), 'two':('2 PCs waiting at once, two SIMs', two_waiting), 'non':('non-LMIS SMS ignored', non_lmis), 'twice':('the same code twice', twice), 'off':('switch off / permission', off_and_perm), 'asleep':('phone asleep', asleep), 'closed':('app closed', closed), 'nobody':('nobody waiting', nobody_waiting)}
for k in which:
    if k=='two': pass
    run(*T[k])
    if k=='two': prefs('on','nuzla · 0911000000')
