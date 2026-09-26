"""Desktop acceptance in an existing live client with a character; uses temporary fixtures.
Run after building and installing the current plugin. This sends real input and
briefly activates Studio. --restart-daemon tests crash recovery without stopping play.
--out receives report.json (environment, every check with its evidence, the first
error, cleanup and the verdict), each scenario submitted and each job's receipt.
"""
import argparse, json, platform, shutil, subprocess, time, traceback
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--restart-daemon', action='store_true')
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=False)
cli = ['node', str(ROOT/'dist/cli-main.js')]
def now(): return datetime.now(timezone.utc).isoformat(timespec='seconds')
report = {
    'started_at': now(),
    'platform': {'macos': platform.mac_ver()[0], 'machine': platform.machine()},
    'cli_version': json.loads((ROOT/'package.json').read_text())['version'],
    'restart_daemon': args.restart_daemon,
    'expected_checks': 7 if args.restart_daemon else 6,
    'checks': [], 'jobs': [],
}

def call(*argv, okay=True):
    p = subprocess.run(cli+list(argv), cwd=ROOT, text=True, capture_output=True, timeout=90)
    value = json.loads(p.stdout)
    if okay and p.returncode:
        raise AssertionError((argv, p.returncode, value))
    return p.returncode, value

def evaluate(code):
    return call('eval', code, '--target', 'client-1')[1]['result']

def record(name, evidence):
    report['checks'].append({'name': name, 'passed': True, 'evidence': evidence})
    (args.out/'report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(name, 'PASS', flush=True)

def submit(steps, name, resume=True):
    scenario = {'steps': steps}
    if resume: scenario['resume_when'] = {'target':'client-1','code':'return _G.RobloxCliAcceptance ~= nil'}
    file = args.out/(name+'.json');file.write_text(json.dumps(scenario))
    value = call('test','play','--scenario',str(file),'--keep-open','--detach')[1]
    report['jobs'].append(value['job_id'])
    return value['job_id']

def status(job): return call('test','job','--job',job)[1]
def await_state(job, predicate, timeout=60):
    until = time.monotonic()+timeout
    while time.monotonic()<until:
        value = status(job)
        if predicate(value): return value
        time.sleep(.1)
    raise AssertionError(('job timeout', value))
def settled(job): return await_state(job, lambda s:s['state'] not in ['queued','running','cancelling'])
def result(job):
    s=settled(job)
    receipt=args.out/(job+'.result.json')
    shutil.copyfile(s['result_file'],receipt)
    return json.loads(receipt.read_text())

try:
    report['status']=call('status')[1]
    call('eval','--file',str(ROOT/'tests/native/setup.luau'),'--target','client-1')
    targets=json.loads((ROOT/'tests/native/targets.json').read_text())
    job=submit(targets['steps'],'targets');receipt=result(job)
    assert receipt['passed'] and receipt['capture_passed'], receipt
    record('GUI, world and prompt activation; calibrated capture; frame sample', {'job':job,'focus':receipt['evidence']['focus_release']})
    for name, before in [('disabled','return true'),('covered','game.Players.LocalPlayer.PlayerGui.RobloxCliAcceptance.Blocker.Visible=true;return true')]:
        evaluate(before)
        path=['RobloxCliAcceptance','Disabled' if name=='disabled' else 'Increment']
        rejected=submit([{'type':'click_gui','path':path}],name)
        r=result(rejected)
        assert not r['passed'] and evaluate('return _G.RobloxCliAcceptance.clicks')==1, r
        record(name+' GUI refuses input',{'job':rejected,'error':r['steps'][0]})
    evaluate('local g=game.Players.LocalPlayer.PlayerGui.RobloxCliAcceptance;g.Clipper.Visible=true;g.Overflow.Visible=true;workspace.RobloxCliAcceptance.Target.Prompt.Enabled=false;return true')
    code, diagnostics=call('test','diagnose','--checks','ui',okay=False)
    ui=diagnostics['result']['ui']
    assert code==1 and all(ui[k] for k in ['text_overflow','clipped_controls','overlaps']), diagnostics
    record('Diagnostics identify overflow, clipping and blockers',diagnostics)
    evaluate('local g=game.Players.LocalPlayer.PlayerGui.RobloxCliAcceptance;g.Clipper.Visible=false;g.Overflow.Visible=false;g.Blocker.Visible=false;return true')
    cancel_steps=json.loads((ROOT/'tests/native/cancel.json').read_text())['steps']
    job=submit(cancel_steps,'cancellation')
    await_state(job,lambda s:s.get('in_flight',{}).get('index')==1)
    call('test','cancel','--job',job)
    s=settled(job)
    state=evaluate('return {clicks=_G.RobloxCliAcceptance.clicks,presses=_G.RobloxCliAcceptance.presses,releases=_G.RobloxCliAcceptance.releases,held=game:GetService("UserInputService"):IsKeyDown(Enum.KeyCode.P)}')
    assert s['state']=='cancelled' and state['clicks']==1 and not state['held'] and state['releases']>=state['presses'], state
    record('Cancel stops subsequent action and releases held key',{'job':job,'state':state})
    call('test','resume','--job',job,'--detach')
    r=result(job)
    assert r['passed'] and evaluate('return _G.RobloxCliAcceptance.clicks')==2, r
    record('Resume continues remaining wait without replaying held key',{'job':job})
    if args.restart_daemon:
        steps=[{'type':'eval','target':'client-1','code':'_G.RobloxCliAcceptance.recovered=1;task.wait(10);return true','expect':{'target':'client-1','code':'return _G.RobloxCliAcceptance.recovered==1'}},{'type':'eval','target':'client-1','code':'_G.RobloxCliAcceptance.tail=(_G.RobloxCliAcceptance.tail or 0)+1;return true'}]
        job=submit(steps,'daemon-interruption')
        await_state(job,lambda s:s.get('in_flight',{}).get('index')==0)
        time.sleep(.3)
        call('daemon','restart')
        until=time.monotonic()+30
        while time.monotonic()<until:
            code,value=call('status',okay=False)
            if not code and value.get('instances') and any('client-1' in i.get('roles',[]) for i in value['instances']):break
            time.sleep(.2)
        s=status(job);assert s['state']=='unknown',s
        # The interrupted eval is allowed to finish before reading its postcondition.
        time.sleep(10)
        call('test','resume','--job',job,'--detach')
        r=result(job)
        assert r['passed'] and r['steps'][0]['recovered_by']=='expect' and evaluate('return _G.RobloxCliAcceptance.tail')==1, r
        record('Daemon restart retains unknown action; verified resume skips replay',{'job':job})
except BaseException as error:
    report['error']=''.join(traceback.format_exception_only(type(error),error)).strip()
    raise
finally:
    try:
        code, cleanup=call('eval','--file',str(ROOT/'tests/native/cleanup.luau'),'--target','client-1',okay=False)
        report['cleanup']={'exit_code':code,'response':cleanup}
    except Exception as error:
        report['cleanup']={'error':''.join(traceback.format_exception_only(type(error),error)).strip()}
    report['finished_at']=now()
    report['passed']='error' not in report and report['cleanup'].get('exit_code')==0 and len(report['checks'])==report['expected_checks']
    (args.out/'report.json').write_text(json.dumps(report,indent=2)+'\n')
