index.html is the ONLY file the app needs. It is built from the two sources here.

  build/_shell.html   all markup, CSS and the inline <symbol> icon set
  build/_engine.js    all app JavaScript, starting with its own <script> tag
  build/_sprite.svg   icon geometry harvested from chatgpt.com's shared-sidebar sprite
                      (already inlined into _shell.html as <symbol id="ri-...">)

Rebuild after editing either source:

  python build/rebuild.py

Check it (rebuilds, then verifies):

  python build/verify.py

verify.py fails loudly when the sources drift apart: a $("id") in the engine with no
matching element in the markup, an unbalanced CSS brace, a JS syntax error, a leftover
data-stub control, or an external asset reference that would break the one-file rule.

Preview screenshots in ../preview were rendered at 1534x695 (the CSS size of the
1917x869 reference captures at Windows 125% scaling) by headless Chrome using a
throwaway profile, never the real one.
