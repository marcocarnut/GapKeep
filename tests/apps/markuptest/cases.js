// Markup and whether it is valid, for this app and tests/i18n/check_tool.py
// (src/runtime/markup.cpp and tools/i18n.py must agree). One JSON array.
export const CASES = [
[
"plain text",
true
],
[
"",
true
],
[
"a > b",
true
],
[
"<tt>mono</tt>",
true
],
[
"<big>B</big><small>s</small>",
true
],
[
"<u>u</u> <s>s</s>",
true
],
[
"<span color='#f00'>x</span>",
true
],
[
"<span color=\"#ff0000\" size=\"20\">x</span>",
true
],
[
"<span font_family='monospace' underline='single' strikethrough='true'>x</span>",
true
],
[
"<span foreground='#abc'>x</span>",
true
],
[
"<span underline='none'>x</span>",
true
],
[
"<tt><big><u>nested</u></big></tt>",
true
],
[
"</tt >",
false
],
[
"&lt;&gt;&amp;&quot;&apos;&#65;&#x20BF;",
true
],
[
"<span color='&#x23;fff'>x</span>",
true
],
[
"<b>bold</b>",
false
],
[
"<i>italic</i>",
false
],
[
"<foo>x</foo>",
false
],
[
"<TT>x</TT>",
false
],
[
"<tt>open",
false
],
[
"close</tt>",
false
],
[
"<u><s>x</u></s>",
false
],
[
"a & b",
false
],
[
"&nope;",
false
],
[
"&#0;",
false
],
[
"&#xD800;",
false
],
[
"&#1114112;",
false
],
[
"<span size='13'>x</span>",
false
],
[
"<span size='16px'>x</span>",
false
],
[
"<span color='red'>x</span>",
false
],
[
"<span color=#f00>x</span>",
false
],
[
"<span bgcolor='#fff'>x</span>",
false
],
[
"<span background='#fff'>x</span>",
false
],
[
"<span font_family='serif'>x</span>",
false
],
[
"<span weight='bold'>x</span>",
false
],
[
"<span color='#f00' color='#0f0'>x</span>",
false
],
[
"<tt color='#f00'>x</tt>",
false
],
[
"<span color='<'>x</span>",
false
],
[
"<span underline='double'>x</span>",
false
],
[
"<",
false
],
[
"x <tt",
false
],
[
"<tt/>",
false
],
[
"<>",
false
],
[
"<span><span><span><span><span><span><span><span><span><span><span><span><span><span><span><span><span>x</span></span></span></span></span></span></span></span></span></span></span></span></span></span></span></span></span>",
false
],
[
"<span><span><span><span><span><span><span><span><span><span><span><span><span><span><span><span>x</span></span></span></span></span></span></span></span></span></span></span></span></span></span></span></span>",
true
]
];
