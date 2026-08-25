# gitva in a page of your own

A tutorial that walks nine git commands, drawing what each one did to the object graph.
It uses nothing but `gitva/canvas`: no server, no git, no route — the steps were recorded
once and are read out of `steps.json`.

```
npm install
npm start          # http://localhost:5173
```

`index.html` maps the bare specifier with an import map, which is the no-build path; a
bundler (vite, esbuild, anything) resolves `gitva/canvas` on its own and needs no map.

To teach a different lesson, record your own steps: run gitva on a scratch repository, type
the commands, then take the recording off the event stream and write the slide text beside
it in `lesson.js`.

```
curl -sN -m 3 localhost:8080/events | grep -m1 '^data: \[' | cut -c7- > steps.json
```

That writes whole steps, which is what the canvas is handed and what a recording is: every
object, the whole index, every ref, restated on every step. It draws as it stands — but it is
nine hundred lines of the same seven objects, so the steps here are cut down to what each
command *added*, and `steps.js` fills the rest back in from what git itself would work out.
The first step is left spelled out in full, as the reference for what a step holds.
