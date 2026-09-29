/** Entirely invented fixtures. No DayZ or third-party mod content is included. */
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE = 'ExampleMod/anims/bird.aw';
export const MAIN_GRAPH = 'ExampleMod/anims/bird_main.agr';

export const syntheticFiles = {
  [WORKSPACE]: `$animWorkspace {
 #animSetTemplate "ExampleMod/anims/bird.ast"
 #NanimSetInstances 1
 #animSetInstance "ExampleMod/anims/bird.asi"
 #previewModel "ExampleMod/bird.xob"
 #animGraph "ExampleMod/anims/bird.agr"
}
`,
  'ExampleMod/anims/bird.ast': `$animsettemplate {
 #ngrouptypes 1
 $groupType {
  #ngroupnames 0
  #nanims 2
  $anims {
   "Idle"
   "Move"
  }
 }
}
`,
  'ExampleMod/anims/bird.asi': `$animsetinstance {
 #template "ExampleMod/anims/bird.ast"
 #nparents 0
 $animations {
  "Idle" "ExampleMod/anims/Idle.anm"
  "Move" "ExampleMod/anims/Move.anm"
 }
}
`,
  'ExampleMod/anims/bird.agr': `$AnimGraph 7 {
 #AnimSetTemplate "ExampleMod/anims/bird.ast"
 $Controls {
  $Commands {
   CMD_START -1
  }
  $Vars {
   #Var Speed float 0 0 10 ""
   #Var Enabled int 1 0 1 ""
  }
  $Expressions {
  }
  $DebugControls {
   #DCtrl 2 "" "Start" "" "CMD_START" 0 0
  }
 }
 $Files {
  "ExampleMod/anims/bird_main.agr"
 }
}
`,
  [MAIN_GRAPH]: `$AnimGraph 7 {
 $Sheet "Main" {
  $Node AnimNodeStateMachine {
   "Bird" ""
   $States 2 {
    $State {
     "IdleState" "" "IdleSource" "true" realtime 0
     $EditorData {
      #EditorPos 10 -20
     }
    }
    $State {
     "MoveState" "" "MoveSource" "" notime 0
     $EditorData {
      #EditorPos 30 -20
     }
    }
   }
   $Transitions 1 {
    $Transition {
     "IdleState" "MoveState" "Speed > 0" "0.2" "0.0" 0 "S"
    }
   }
   $EditorData {
    #EditorPos 10 -10
   }
  }
  $Node AnimNodeSource {
   "IdleSource" "" "Idle" loop
   $Predictions {
   }
   $EditorData {
    #EditorPos 10 -30
   }
  }
  $Node AnimNodeSource {
   "MoveSource" "moving" "Move" noloop
   $Predictions {
   }
   $EditorData {
    #EditorPos 30 -30
   }
  }
 }
}
`,
  // Opaque copy-test payloads, deliberately not valid ANM or XOB assets.
  'ExampleMod/anims/Idle.anm': Buffer.from([0x53, 0x59, 0x4e, 0x00, 0x01]),
  'ExampleMod/anims/Move.anm': Buffer.from([0x53, 0x59, 0x4e, 0x00, 0x02]),
  'ExampleMod/bird.xob': Buffer.from([0x53, 0x59, 0x4e, 0x00, 0x03]),
  'ExampleMod/notes.txt': 'Synthetic unchanged copy sentinel.\n',
  'ExampleMod/unused.agr': 'Inactive legacy file copied without conversion.\n',
};

/** Create a fresh synthetic source tree; overrides are test-owned relative paths. */
export async function writeSyntheticProject(root, overrides = {}) {
  await fs.mkdir(root, { recursive: true });
  for (const [resource, content] of Object.entries({ ...syntheticFiles, ...overrides })) {
    if (content === null) continue;
    const file = path.join(root, resource);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return { root, workspace: WORKSPACE };
}
