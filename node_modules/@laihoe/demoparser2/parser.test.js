
var {parseEvent, parseEvents,parseTicks, parsePlayerInfo, parseGrenades, listGameEvents, parseHeader} = require('./index');
const fs = require('fs');
const path = require('path');


function sum(a, b) {
    return a + b;
}
  
let filePath = "/home/laiho/Documents/programming/rust/cs2/src/python/tests/data/test.dem"

test('parse_event', () => {
    let event_correct = JSON.stringify(JSON.parse(fs.readFileSync("parse_event.json")));
    let event = JSON.stringify(parseEvent(filePath, "player_blind", ["X", "Y"], ["total_rounds_played"]));
    expect(event).toBe(event_correct);
});

test('parse_events', () => {
    let event_correct = JSON.stringify(JSON.parse(fs.readFileSync("parse_events.json")));
    let x = parseEvents(filePath, ["player_death"], ["X", "Y"], ["total_rounds_played"])
    let event = JSON.stringify(x);
    expect(event).toBe(event_correct);
});