var s = require("fs").readFileSync("js/script.js", "utf8").split("\n");
var out = [];
for (var i = 7482; i < s.length; i++) {
  var re = /t\("([^"]+)"\)/g, m;
  while ((m = re.exec(s[i]))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
}
console.log(JSON.stringify(out, null, 1));
