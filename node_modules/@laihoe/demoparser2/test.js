
var {parseEvent, parseEvents,parseTicks, parsePlayerInfo, parseGrenades, listGameEvents, parseHeader, parseVoice} = require('./index');
const fs = require('fs');
const path = require('path');

try {
  const files = fs.readdirSync("/home/laiho/Documents/demos/cs2/test3/");
  files.forEach(file => {
    const filePath = path.join("/home/laiho/Documents/demos/cs2/test3/", file);
    let y = parseEvent(filePath, "player_death", ["inventory"], [])
    let x = parseVoice(filePath, "player_death", ["inventory"], [])
    console.log(x)
  });
} catch (err) {
  console.error(err);
}

var {parseEvent, parseTicks} = require('./index');
// The event includes a field called site, but it gives you a big int like 204 etc.
// This will give you fields like "BombsiteA" and "BombsiteB"
// let events = parseEvent("/home/laiho/Documents/demos/cs2/test3/1.dem", "weapon_fire", ["X", "Y"])

// filtered = events.filter(e => e.weapon == "weapon_smokegrenade")
// let path = "/home/laiho/Documents/demos/cs2/test3/1.dem"
// let detonate_eve = parseEvent("/home/laiho/Documents/demos/cs2/test3/1.dem", "smokegrenade_detonate", ["X", "Y"])
// let d = parseTicks(path, ["active_weapon_name"])
// console.log(d)
