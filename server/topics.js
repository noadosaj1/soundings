"use strict";
/*
 * Topics and game modes. To add a topic: add an entry here (id, group, name, colour,
 * description, 9×9 pixel icon: "#" = colour, "+" = highlight, "." = empty) and give at least
 * 7 questions in the bank that `topic` to it. The topic screen, picker and stats pick it up.
 */
const GROUPS = [
  { id: "general", name: "General knowledge" },
  { id: "nature", name: "Nature & science" },
  { id: "entertainment", name: "Entertainment" },
  { id: "culture", name: "History & culture" },
];

const I = s => s.trim().split(/\s+/);
const TOPICS = [
  { id: "general", group: "general", name: "General trivia", colour: "#54d6d0", description: "A bit of everything: cards, calendars, kitchens and games.",
    icon: I(`..#####.. .##...##. .....##.. ....##... ...##.... ...##.... ......... ...++.... ...++....`) },
  { id: "science", group: "general", name: "Science", colour: "#7ad1ff", description: "Elements, units, particles and the stuff of the universe.",
    icon: I(`...###... ....#.... ....#.... ...#.#... ..#...#.. .#.+++.#. #.+++++.# #+++++++# .#######.`) },
  { id: "history", group: "general", name: "History", colour: "#e8b84a", description: "Presidents, monarchs and the people who ran the show.",
    icon: I(`.#######. #.......# .#+++++#. .#.....#. .#+++++#. .#.....#. .#+++++#. #.......# .#######.`) },
  { id: "geography", group: "general", name: "Geography", colour: "#5fd38a", description: "Countries, capitals, coasts, peaks and seas.",
    icon: I(`..#####.. .#++.+.#. #+++..+.# #.++....# #..+++..# #....++.# #....+..# .#.....#. ..#####..`) },
  { id: "literature", group: "general", name: "Literature", colour: "#d9a0ff", description: "Novels, plays and the characters who live in them.",
    icon: I(`......... ###...### #++#.#++# #++.#.++# #++.#.++# #++.#.++# #++.#.++# ####.#### .........`) },

  { id: "marine", group: "nature", name: "Marine life", colour: "#3fc7c0", description: "Whales, sharks, molluscs and everything in the deep.",
    icon: I(`......... ....###.. #..#+++#. ##.++++.# ####+.++# ##.++++.# #..#+++#. ....###.. .........`) },
  { id: "dinosaurs", group: "nature", name: "Dinosaurs", colour: "#9bd86f", description: "Theropods, sauropods and the prehistoric world.",
    icon: I(`....####. ...#+.+## ...#++++# ...#++### #..#++#.. ##.#++#.. .######.. ..#..#... ..#..#...`) },
  { id: "animals", group: "nature", name: "Animals", colour: "#ffb36b", description: "Cats, primates, marsupials, snakes and breeds.",
    icon: I(`.#.....#. ###...### .#..#..#. ...###... ..#####.. .###+###. .#+++++#. ..#####.. .........`) },
  { id: "space", group: "nature", name: "Space & astronomy", colour: "#9aa8ff", description: "Planets, stars, galaxies and the missions to reach them.",
    icon: I(`......... ...###... ..#+++#.. ######### #.#+++#.# ######### ..#+++#.. ...###... .........`) },
  { id: "biology", group: "nature", name: "Human biology", colour: "#ff7a8a", description: "Bones, muscles, organs and the senses.",
    icon: I(`......... .##...##. #++#.#++# #+++#+++# #+++++++# .#+++++#. ..#+++#.. ...#+#... ....#....`) },

  { id: "movies", group: "entertainment", name: "Movies", colour: "#ff9a5c", description: "Directors, studios, franchises and award winners.",
    icon: I(`#.#.#.#.# ######### ......... ######### #+++++++# #+++++++# #+++++++# #+++++++# #########`) },
  { id: "television", group: "entertainment", name: "Television", colour: "#7fe0ff", description: "Sitcoms, sagas, puppets and streaming.",
    icon: I(`..#...#.. ...#.#... ....#.... ######### #+++++#.# #+++++#+# #+++++#.# ######### .#.....#.`) },
  { id: "music", group: "entertainment", name: "Music", colour: "#f27fb0", description: "Bands, albums, composers and the voice.",
    icon: I(`...#####. ...#++++# ...#...+# ...#....# ...#....# .###..### #++#.#++# #++#.#++# .##...##.`) },
  { id: "videogames", group: "entertainment", name: "Video games", colour: "#8fe36b", description: "Consoles, characters, creatures and classic blocks.",
    icon: I(`......... .#######. #+++++++# #.#+++#+# ###+++#.# #.#++#+#+ #+++++++# .#######. .........`) },
  { id: "popculture", group: "entertainment", name: "Pop culture", colour: "#f4c95a", description: "Brands, bands, apps and famous families.",
    icon: I(`....#.... ...#+#... ####+#### .#+++++#. ..#+++#.. .#+#.#+#. .#.....#. ......... .........`) },

  { id: "ancient", group: "culture", name: "Ancient civilizations", colour: "#e0c08a", description: "Pharaohs, emperors, philosophers and lost cities.",
    icon: I(`....#.... ...#+#... ..#+++#.. .#+++++#. #+++++++# ######### .#.#.#.#. .#.#.#.#. #########`) },
  { id: "mythology", group: "culture", name: "Mythology", colour: "#b48cff", description: "Gods, monsters, muses and legendary knights.",
    icon: I(`.....##.. ....##... ...##.... ..#####.. ....##... ...##.... ..##..... .##...... .#.......`) },
  { id: "worldhistory", group: "culture", name: "World history", colour: "#d98a5f", description: "Empires, alliances, explorers and turning points.",
    icon: I(`#.......# .#.....#. ..#...#.. ...#.#... ....#.... ...#.#... ..#...#.. .++...++. ++.....++`) },
  { id: "people", group: "culture", name: "Famous people", colour: "#ffd27a", description: "Champions, pioneers, first ladies and moonwalkers.",
    icon: I(`...###... ..#+++#.. ..#+++#.. ...###... ..#####.. .#+++++#. #+++++++# #+++++++# #########`) },
  { id: "art", group: "culture", name: "Art & architecture", colour: "#ff8fb8", description: "Painters, movements, styles and great buildings.",
    icon: I(`..#####.. .#+++++#. #+#++++.# #++++#++# #+#+++++# #+++++.## .#+++#... ..###.... .........`) },
];

/*
 * Game modes. questionMs is the per-question timer (configurable here, no daily timer).
 *  quick:   7 questions from one topic, random order.
 *  special: 7 questions from one topic in rising difficulty, 30 s each; scored with a mastery rank.
 *  mixed:   7 questions, each from a different topic.
 *  endless: keep diving until you surface or run out of air (3 tanks; a pass or timeout costs one).
 */
const MODES = {
  quick:   { id: "quick",   name: "Quick Dive",    rounds: 7,  questionMs: 25_000, topic: "required", rules: "7 questions from one topic. 25 seconds each." },
  special: { id: "special", name: "Topic Special", rounds: 7,  questionMs: 30_000, topic: "required", rules: "7 questions from one topic, easy to hard. 30 seconds each. Earn a mastery rank." },
  mixed:   { id: "mixed",   name: "Mixed Dive",    rounds: 7,  questionMs: 25_000, topic: "none",     rules: "7 questions, each from a different topic. 25 seconds each." },
  endless: { id: "endless", name: "Endless Dive",  rounds: 60, questionMs: 20_000, topic: "optional", lives: 3, rules: "Dive until you surface or run out of air. 3 air tanks; a pass or timeout costs one. 20 seconds each." },
};

module.exports = { GROUPS, TOPICS, MODES };
