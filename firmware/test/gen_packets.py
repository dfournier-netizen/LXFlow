# Writes test packets shaped like what Companion, grandMA3 and QLab send.
from pythonosc.osc_message_builder import OscMessageBuilder
from pythonosc.osc_bundle_builder import OscBundleBuilder, IMMEDIATELY
import sys
def msg(addr, *args, types=None):
    b = OscMessageBuilder(address=addr)
    for i, a in enumerate(args):
        b.add_arg(a, types[i] if types else None)
    return b.build().dgram
pk = {
  'companion_noargs': msg('/cuelight/LX/go'),
  'companion_int':    msg('/cuelight/all/standby', 1),
  'ma3_int':          msg('/ma3/exec/201', 1),
  'ma3_float':        msg('/ma3/fader/201', 0.5),
  'ma3_string':       msg('/cmd', 'Go+ Sequence 5'),
  'qlab_look':        msg('/cuelight/LX/look', 255, 160, 0, 'pulse', 2000, 80),
  'qlab_true':        msg('/cue/5/go', True),
  'qlab_false':       msg('/cue/5/go', False),
  'double':           msg('/x', 2.25, types=['d']),
  'int64':            msg('/x', 5, types=['h']),
  'nil':              msg('/x', None),
}
bb = OscBundleBuilder(IMMEDIATELY)
for a in (msg('/cuelight/LX/hold'), msg('/cuelight/Video/call')): 
    from pythonosc.osc_message import OscMessage
    bb.add_content(OscMessage(a))
pk['bundle'] = bb.build().dgram
with open(sys.argv[1], 'w') as f:
    for k, v in pk.items(): f.write(k + ' ' + v.hex() + '\n')
