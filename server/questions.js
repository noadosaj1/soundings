"use strict";
/*
 * Soundings question bank — original content.
 *
 * Each question is open-ended: many answers are valid, and rarer valid answers score more.
 *
 * answers: entries separated by ";".  Entry format:  Canonical|alias|alias:weight
 *   - Canonical is what players see in results.
 *   - Aliases are alternative names/spellings (normalisation also handles case, accents,
 *     punctuation, plurals and small typos — see engine.js).
 *   - weight = DEVELOPMENT SEED ESTIMATE of how often players would give this answer
 *     (relative, any scale). It is NOT real player data. Live answer counts recorded by the
 *     server are blended in and outweigh the seed as real data accumulates (engine.rarity).
 *     Entries without a weight get a graded estimate from their position in the list
 *     (entries are listed most-common first; see engine.buildCatalog).
 * explain: the "correct answer explanation" shown after the question closes.
 * topic / difficulty: used by the topic picker and the Topic Special mode.
 * strip: words removed from the player's answer and from every alias before matching,
 *   so "Pacific Ocean" == "Pacific". An answer made only of strip words is rejected.
 * Ids are permanent: they key the recorded answer counts. Never reuse or renumber them.
 */
const BASE = [
{ id: "oceans-seas", text: "Name an ocean or a sea", hint: "Any named ocean or sea of Earth's World Ocean", strip: ["ocean", "sea", "of", "the"],
  answers: "Pacific:30;Atlantic:25;Indian:8;Arctic:6;Southern|Antarctic:3;Mediterranean|med:8;Caribbean:4;Red:3;Black:3;Baltic:2;North:2;Arabian:1;Coral:1;Tasman:1;South China:1;East China:0.5;Bering:1;Sargasso:0.5;Aegean:1;Adriatic:1;Ionian:0.5;Tyrrhenian;Ligurian;Weddell;Ross;Barents:0.4;Kara;Laptev;Beaufort:0.3;Labrador:0.3;Norwegian:0.4;Irish:0.4;Celtic;Yellow:0.5;Japan|East Sea:0.5;Philippine;Andaman;Timor;Arafura;Bismarck;Solomon;Sulu;Celebes;Java;Banda;Okhotsk:0.3;White;Marmara:0.3;Azov:0.2;Salish;Greenland:0.3;Alboran;Balearic;Scotia;Amundsen;Bellingshausen;Chukchi;East Siberian;Wadden;Bohai;Molucca;Flores;Savu;Halmahera;Seram;Sibuyan;Visayan;Laccadive;Hebrides;Irminger;Lincoln;Wandel;Pechora;Cretan;Thracian;Libyan;Levantine;Cilician" },

{ id: "planets", text: "Name a planet in our solar system", hint: "One of the eight planets", strip: ["planet", "the"],
  answers: "Mercury:10;Venus:12;Earth:15;Mars:25;Jupiter:15;Saturn:12;Uranus:6;Neptune:5" },

{ id: "brazil-borders", text: "Name a country that shares a land border with Brazil", hint: "Brazil has ten neighbours", strip: ["the"],
  answers: "Argentina:30;Uruguay:8;Paraguay:8;Bolivia:10;Peru:12;Colombia:14;Venezuela:12;Guyana:3;Suriname|Surinam:2;France|French Guiana:1" },

{ id: "sea-mammals", text: "Name a mammal that lives in or depends on the ocean", hint: "Whales, seals, sirenians and more", strip: ["the"],
  answers: "Whale:20;Dolphin:22;Seal:14;Sea lion|sealion:6;Walrus:5;Orca|killer whale:7;Manatee|sea cow:4;Dugong:1;Sea otter|otter:3;Narwhal:2;Beluga|beluga whale|white whale:1.5;Porpoise:1.5;Blue whale:3;Humpback whale|humpback:1.5;Sperm whale:1;Polar bear:1;Minke whale|minke:0.3;Fin whale|finback:0.2;Gray whale|grey whale:0.3;Bowhead whale|bowhead:0.2;Right whale:0.2;Pilot whale:0.2;Elephant seal:0.5;Leopard seal:0.4;Harp seal:0.3;Fur seal:0.3;Monk seal:0.2;Bottlenose dolphin:0.5;Vaquita;Beaked whale;Sei whale;Bryde's whale|brydes whale;Marine otter;Steller sea lion;Weddell seal;Crabeater seal;Hooded seal;Ringed seal;Harbour seal|harbor seal|common seal;Grey seal|gray seal" },

{ id: "rainbow", text: "Name a colour of the rainbow", hint: "Traditional seven-colour rainbow", strip: ["the", "colour", "color"],
  answers: "Red:30;Orange:12;Yellow:14;Green:14;Blue:16;Indigo:5;Violet|purple:9" },

{ id: "chess", text: "Name a chess piece", hint: "Pieces that start on the board", strip: ["the", "piece"],
  answers: "King:30;Queen:25;Rook|castle|tower:12;Bishop:12;Knight|horse:14;Pawn:15" },

{ id: "bones", text: "Name a bone in the human body", hint: "Common or anatomical names both count", strip: ["the", "bone", "human"],
  answers: "Femur|thigh:25;Skull|cranium:10;Tibia|shin:7;Fibula:4;Humerus:5;Radius:3;Ulna:3;Rib:12;Sternum|breastbone|breast:2;Clavicle|collarbone|collar:5;Scapula|shoulder blade:2;Patella|kneecap|knee cap:3;Pelvis|hip:3;Vertebra|vertebrae|spine|backbone:3;Mandible|jawbone|jaw:2;Stapes|stirrup:1;Incus|anvil:0.4;Malleus|hammer:0.4;Hyoid:0.3;Coccyx|tailbone|tail:1;Sacrum:0.4;Metacarpal:0.3;Phalanx|phalanges|phalange:0.6;Carpal:0.3;Tarsal:0.3;Metatarsal:0.4;Calcaneus|heel:0.3;Talus|ankle:0.2;Maxilla:0.2;Ilium;Ischium;Pubis;Zygomatic|cheekbone|cheek;Sphenoid;Ethmoid;Occipital;Parietal;Temporal;Frontal;Nasal;Lacrimal;Vomer;Palatine;Scaphoid;Lunate;Hamate;Capitate;Trapezium;Trapezoid;Pisiform;Triquetrum;Cuboid;Navicular;Cuneiform;Atlas;Axis" },

{ id: "edible-fish", text: "Name a fish that people commonly eat", hint: "Any edible fish species", strip: ["the", "fish"],
  answers: "Salmon:25;Tuna:20;Cod:15;Haddock:3;Trout:4;Mackerel:3;Sardine|pilchard:3;Anchovy:2;Halibut:2;Sole:1;Herring:2;Tilapia:3;Catfish:2;Sea bass|bass|seabass|branzino:2;Snapper|red snapper:1;Swordfish:1;Mahi mahi|dorado|dolphinfish:1;Carp:0.8;Pollock|pollack:0.8;Plaice:0.5;Sturgeon:0.3;Eel:0.5;Monkfish:0.4;Turbot:0.3;Grouper:0.4;Perch:0.4;Pike:0.3;Whiting:0.3;Hake:0.4;Bream|sea bream:0.3;Barramundi:0.3;Flounder:0.4;Yellowtail|hamachi:0.3;Skate:0.2;John Dory;Mullet;Marlin;Kingfish;Walleye;Pompano;Wahoo;Shad;Smelt;Sprat;Lingcod;Rockfish;Bluefish;Arctic char|char;Pangasius|basa|swai;Milkfish;Bonito;Butterfish;Hoki;Orange roughy;Dab;Brill;Gurnard;Pickerel;Crappie;Bluegill;Zander;Loach;Snakehead;Rohu;Hilsa;Pomfret" },

{ id: "elements", text: "Name a chemical element", hint: "Any element on the periodic table", strip: ["the", "element"],
  answers: "Hydrogen:15;Helium:6;Lithium:2;Beryllium;Boron;Carbon:10;Nitrogen:5;Oxygen:15;Fluorine:0.5;Neon:2;Sodium:3;Magnesium:1;Aluminium|aluminum:1.5;Silicon:1;Phosphorus:0.5;Sulfur|sulphur:1;Chlorine:1;Argon:0.5;Potassium:1;Calcium:2;Scandium;Titanium:1;Vanadium;Chromium:0.3;Manganese;Iron:6;Cobalt:0.3;Nickel:0.5;Copper:3;Zinc:1;Gallium;Germanium;Arsenic:0.3;Selenium;Bromine;Krypton:0.5;Rubidium;Strontium;Yttrium;Zirconium;Niobium;Molybdenum;Technetium;Ruthenium;Rhodium;Palladium;Silver:3;Cadmium;Indium;Tin:1;Antimony;Tellurium;Iodine:0.4;Xenon:0.3;Caesium|cesium;Barium;Lanthanum;Cerium;Praseodymium;Neodymium;Promethium;Samarium;Europium;Gadolinium;Terbium;Dysprosium;Holmium;Erbium;Thulium;Ytterbium;Lutetium;Hafnium;Tantalum;Tungsten|wolfram;Rhenium;Osmium;Iridium;Platinum:1;Gold:6;Mercury:1.5;Thallium;Lead:2;Bismuth;Polonium;Astatine;Radon;Francium;Radium;Actinium;Thorium;Protactinium;Uranium:1.5;Neptunium;Plutonium:0.5;Americium;Curium;Berkelium;Californium;Einsteinium;Fermium;Mendelevium;Nobelium;Lawrencium;Rutherfordium;Dubnium;Seaborgium;Bohrium;Hassium;Meitnerium;Darmstadtium;Roentgenium;Copernicium;Nihonium;Flerovium;Moscovium;Livermorium;Tennessine;Oganesson" },

{ id: "africa", text: "Name a country in Africa", hint: "Any of Africa's 54 UN member states", strip: ["the", "republic", "of"],
  answers: "Egypt:15;Nigeria:10;Kenya:9;South Africa:12;Morocco:6;Ethiopia:5;Ghana:5;Algeria:2;Tunisia:2;Libya:1.5;Sudan:1.5;South Sudan:0.5;Somalia:1.5;Uganda:2;Tanzania:2;Rwanda:1.5;Burundi:0.4;Democratic Congo|drc|dr congo|democratic republic congo|congo kinshasa|zaire:1;Congo|congo brazzaville|congo republic:0.8;Cameroon:1;Senegal:1;Mali:0.8;Niger:0.6;Chad:0.5;Mauritania:0.3;Botswana:0.8;Namibia:0.8;Zimbabwe:1.5;Zambia:0.8;Mozambique:0.6;Madagascar:1.5;Angola:0.6;Malawi:0.4;Lesotho:0.2;Eswatini|swaziland:0.2;Ivory Coast|cote divoire|cote d ivoire:0.6;Liberia:0.4;Sierra Leone:0.4;Guinea:0.3;Guinea-Bissau|guinea bissau;Gambia:0.3;Burkina Faso:0.3;Benin;Togo:0.3;Gabon;Equatorial Guinea;Central African Republic|car;Eritrea:0.3;Djibouti:0.2;Cape Verde|cabo verde;Sao Tome and Principe|sao tome;Comoros;Mauritius:0.3;Seychelles:0.3" },

{ id: "orchestra", text: "Name an instrument found in a symphony orchestra", hint: "Strings, woodwind, brass, percussion or keyboard", strip: ["the"],
  answers: "Violin:30;Viola:4;Cello|violoncello:10;Double bass|contrabass|bass|string bass|upright bass:4;Harp:3;Flute:10;Piccolo:1;Oboe:3;Cor anglais|english horn:0.4;Clarinet:5;Bass clarinet:0.2;Bassoon:2;Contrabassoon|double bassoon:0.2;French horn|horn:3;Trumpet:6;Trombone:3;Tuba:2;Timpani|kettle drum|kettledrum|kettle drums:2;Snare drum|snare:0.8;Bass drum:0.5;Cymbal|cymbals:1;Triangle:1;Xylophone:0.6;Glockenspiel:0.4;Celesta|celeste;Piano:3;Tambourine:0.3;Gong|tam tam:0.3;Tubular bells|chimes:0.2;Marimba:0.2;Vibraphone;Castanets;Organ:0.3;Saxophone|sax:0.5;Harpsichord:0.3;Wood block|woodblock;Drum|drums:1.5;Percussion;Euphonium;Cornet;Wagner tuba;Bass trombone;Alto flute;Bass flute;Whip|slapstick;Ratchet;Anvil;Wind machine;Crotales;Cowbell" },

{ id: "tentacles", text: "Name a sea creature with tentacles or arms", hint: "Cephalopods, cnidarians, echinoderms…", strip: ["the"],
  answers: "Octopus:35;Squid:20;Jellyfish|jelly:20;Cuttlefish:3;Nautilus:1;Sea anemone|anemone:3;Starfish|sea star:6;Brittle star:0.3;Sea cucumber:0.3;Portuguese man o war|man o war|man of war:1;Box jellyfish:0.6;Comb jelly|ctenophore:0.2;Hydra:0.2;Coral:0.4;Vampire squid:0.3;Giant squid:0.8;Colossal squid:0.3;Sea lily|crinoid;Basket star;Feather star;Lion's mane jellyfish|lions mane:0.3;Blue-ringed octopus|blue ringed octopus:0.3;Dumbo octopus:0.2;Moon jellyfish|moon jelly:0.2;Siphonophore;Sea pen;Mimic octopus;Argonaut|paper nautilus;Bobtail squid;Firefly squid;Humboldt squid;Giant pacific octopus;Irukandji;Sea wasp;Blue dragon|glaucus" },

{ id: "greek-gods", text: "Name a god, goddess or Titan of Greek mythology", hint: "Olympians, primordials, Titans and minor deities", strip: ["the", "god", "goddess", "titan"],
  answers: "Zeus:30;Hera:8;Poseidon:12;Athena|athene:9;Apollo:7;Artemis:5;Ares:4;Aphrodite:6;Hermes:4;Hephaestus|hephaistos:2;Demeter:1.5;Dionysus|dionysos:2;Hades:6;Hestia:0.8;Persephone:1.5;Eros:0.8;Nike:0.5;Gaia|gaea:0.8;Kronos|cronus|cronos:1;Rhea:0.3;Hecate|hekate:0.4;Pan:0.4;Helios:0.4;Selene:0.2;Eos;Nyx:0.3;Uranus|ouranos:0.2;Iris;Hypnos;Thanatos:0.2;Nemesis:0.2;Tyche;Asclepius|asklepios;Hebe;Eris;Triton;Oceanus|okeanos;Tethys;Amphitrite;Morpheus:0.2;Aeolus;Prometheus:0.5;Atlas:0.5;Themis;Mnemosyne;Chaos;Erebus;Pontus;Nereus;Proteus;Boreas;Zephyrus;Hyperion;Iapetus;Coeus;Crius;Theia;Phoebe;Epimetheus;Metis;Leto;Harmonia;Hymen;Priapus;Ganymede" },

{ id: "root-veg", text: "Name a vegetable that grows underground", hint: "Roots, tubers, bulbs and rhizomes", strip: ["the"],
  answers: "Potato:30;Carrot:30;Onion:8;Garlic:3;Beetroot|beet:4;Radish:4;Turnip:3;Parsnip:3;Sweet potato:3;Yam:1;Ginger:0.6;Cassava|yuca|manioc:0.5;Celeriac:0.3;Rutabaga|swede:0.6;Jicama:0.2;Taro:0.3;Horseradish:0.3;Shallot:0.3;Jerusalem artichoke|sunchoke;Salsify;Daikon:0.2;Lotus root;Burdock;Water chestnut;Turmeric;Arrowroot;Leek:0.3;Black salsify|scorzonera;Oca;Ulluco;Mashua;Yacon;Kohlrabi" },

{ id: "gemstones", text: "Name a gemstone", hint: "Precious or semi-precious", strip: ["the", "stone"],
  answers: "Diamond:30;Ruby:15;Emerald:12;Sapphire:10;Amethyst:4;Topaz:3;Opal:3;Pearl:3;Garnet:1.5;Jade:2;Aquamarine:1;Turquoise:1;Peridot:0.6;Onyx:0.6;Tourmaline:0.4;Citrine:0.4;Tanzanite:0.4;Moonstone:0.3;Lapis lazuli|lapis:0.4;Alexandrite:0.2;Spinel;Zircon;Jasper;Agate:0.3;Malachite;Obsidian:0.2;Quartz:0.5;Rose quartz;Amber:0.3;Coral;Morganite;Beryl;Tiger's eye|tigers eye|tiger eye;Bloodstone;Carnelian;Chrysoberyl;Iolite;Kunzite;Labradorite;Sunstone;Jet;Sodalite;Rhodochrosite;Larimar;Chrysoprase;Fluorite;Hematite;Rhodolite;Tsavorite;Andalusite;Benitoite;Painite;Taaffeite;Sphene|titanite" },

{ id: "ball-sports", text: "Name a sport played with a ball", hint: "Puck and shuttlecock sports don't count", strip: ["the"],
  answers: "Football|soccer|association football:30;Basketball:20;Tennis:10;Baseball:7;Cricket:5;Rugby|rugby union|rugby league:4;Volleyball:5;Golf:4;American football|gridiron:3;Field hockey|hockey:1;Table tennis|ping pong:2;Handball:1;Water polo:1;Squash:0.8;Bowling|ten pin bowling|tenpin bowling:0.8;Softball:0.6;Lacrosse:0.5;Polo:0.4;Netball:0.4;Dodgeball:0.4;Pool|billiards|snooker:0.6;Croquet:0.2;Racquetball:0.2;Kickball:0.2;Beach volleyball:0.3;Australian rules football|aussie rules|afl;Gaelic football;Hurling;Pickleball:0.3;Padel;Sepak takraw;Bocce;Petanque|boules;Korfball;Futsal;Rounders;Wallyball;Jai alai|pelota;Goalball;Sitting volleyball;Footvolley;Teqball;Camogie;Shinty;Fives;Cornhole" },

{ id: "mediterranean", text: "Name a country with a Mediterranean coastline", hint: "Europe, Asia and Africa all touch it", strip: ["the"],
  answers: "Italy:25;Spain:20;Greece:20;France:12;Turkey|turkiye:6;Egypt:5;Croatia:3;Cyprus:2;Malta:2;Israel:1.5;Lebanon:1;Syria:0.8;Libya:1;Tunisia:1;Algeria:0.8;Morocco:1.5;Monaco:1;Albania:0.6;Montenegro:0.4;Slovenia:0.3;Bosnia and Herzegovina|bosnia;Palestine|gaza" },

{ id: "constellations", text: "Name one of the 88 modern constellations", hint: "Zodiac constellations count too", strip: ["the"],
  answers: "Orion:25;Ursa Major|great bear:10;Ursa Minor|little bear:3;Cassiopeia:4;Scorpius|scorpio:3;Leo:3;Taurus:2;Gemini:2;Cancer:1;Virgo:1;Libra:1;Sagittarius:1;Capricornus|capricorn:1;Aquarius:1;Pisces:1;Aries:1;Cygnus:1;Lyra:0.5;Andromeda:2;Perseus:0.8;Pegasus:1;Draco:0.8;Hercules:0.5;Canis Major:0.5;Canis Minor:0.2;Crux|southern cross:1;Centaurus:0.3;Aquila:0.3;Bootes:0.2;Corona Borealis;Cepheus;Auriga;Hydra;Carina;Vela;Puppis;Lupus;Ophiuchus:0.2;Monoceros;Lepus;Columba;Eridanus;Cetus;Phoenix:0.2;Pavo;Tucana;Grus;Delphinus;Sagitta;Vulpecula;Lacerta;Camelopardalis;Lynx;Leo Minor;Coma Berenices;Corvus;Crater;Sextans;Antlia;Pyxis;Chamaeleon;Musca;Apus;Octans;Mensa;Volans;Dorado;Pictor;Reticulum;Horologium;Caelum;Fornax;Sculptor;Microscopium;Indus;Telescopium;Ara;Norma;Circinus;Triangulum;Triangulum Australe;Corona Australis;Scutum;Serpens;Equuleus;Piscis Austrinus;Hydrus;Canes Venatici" },

{ id: "flightless", text: "Name a bird that cannot fly", hint: "Living or recently extinct", strip: ["the", "bird"],
  answers: "Penguin:35;Ostrich:20;Emu:12;Kiwi:8;Chicken:5;Dodo:6;Cassowary:3;Rhea:1;Kakapo:0.6;Takahe:0.3;Weka:0.2;Moa:0.4;Great auk:0.2;Steamer duck;Flightless cormorant|galapagos cormorant;Elephant bird:0.2;Emperor penguin:0.5;King penguin:0.2;Inaccessible island rail;Aptornis;Turkey:0.5" },

{ id: "sharks", text: "Name a living species or type of shark", hint: "Extinct sharks like megalodon don't count", strip: ["the", "shark"],
  answers: "Great white|white|great white pointer:35;Hammerhead|great hammerhead:15;Tiger:8;Bull:5;Whale:8;Mako|shortfin mako:3;Basking:2;Nurse:2;Blue:1.5;Lemon:1;Thresher:1;Goblin:1;Megamouth:0.4;Greenland:0.6;Blacktip|blacktip reef:0.6;Whitetip|oceanic whitetip|whitetip reef:0.5;Sand tiger|grey nurse|ragged tooth:0.3;Angel|angelshark:0.3;Wobbegong:0.2;Cookiecutter|cookie cutter:0.3;Frilled:0.3;Sleeper;Dogfish|spiny dogfish:0.3;Catshark|cat:0.2;Bamboo;Horn;Zebra;Leopard:0.2;Silky;Porbeagle;Salmon;Port Jackson;Lantern|lanternshark;Epaulette;Bonnethead;Sixgill|six gill|bluntnose sixgill;Sevengill|seven gill;Reef:0.3;Swell;Saw|sawshark;Gulper;Bramble;Kitefin;Tope|school;Galapagos;Dusky;Sandbar;Spinner;Copper|bronze whaler;Crocodile;Velvet belly" },

{ id: "pacific-states", text: "Name a US state with a Pacific Ocean coastline", hint: "Five states qualify", strip: ["the", "state"],
  answers: "California:45;Hawaii:20;Oregon:12;Washington:12;Alaska:11" },

{ id: "shakespeare", text: "Name a play by William Shakespeare", hint: "Tragedies, comedies, histories and romances", strip: ["the"],
  answers: "Hamlet:22;Romeo and Juliet|romeo & juliet|romeo:25;Macbeth:18;Othello:5;King Lear|lear:5;A Midsummer Night's Dream|midsummer nights dream|midsummer:6;The Tempest|tempest:3;Twelfth Night:2;Much Ado About Nothing:2;Julius Caesar:3;The Merchant of Venice|merchant of venice:2;As You Like It:1;The Taming of the Shrew|taming of the shrew:1.5;Richard III|richard 3|richard the third:0.8;Henry V|henry 5|henry the fifth:0.6;Antony and Cleopatra:0.6;Coriolanus:0.2;Titus Andronicus:0.3;The Winter's Tale|winters tale:0.2;Cymbeline;Pericles;Measure for Measure:0.2;All's Well That Ends Well|alls well that ends well;The Comedy of Errors|comedy of errors:0.3;Love's Labour's Lost|loves labours lost|loves labors lost;The Two Gentlemen of Verona|two gentlemen of verona;The Merry Wives of Windsor|merry wives of windsor;Troilus and Cressida;Timon of Athens;Richard II|richard 2|richard the second;Henry IV|henry 4|henry the fourth;Henry VI|henry 6|henry the sixth;Henry VIII|henry 8|henry the eighth;King John;The Two Noble Kinsmen|two noble kinsmen" },

{ id: "currencies", text: "Name a currency in use today", hint: "National currency names, no cryptocurrencies", strip: ["the"],
  answers: "Dollar:30;Euro:20;Pound|pound sterling|sterling|quid:12;Yen:8;Yuan|renminbi|rmb:4;Rupee:4;Franc|swiss franc:2;Peso:3;Ruble|rouble:2;Won:1;Real:1;Krona:0.8;Krone:0.6;Rand:1;Lira:1;Dinar:0.6;Dirham:0.6;Riyal:0.5;Shekel:0.5;Baht:0.5;Ringgit:0.3;Rupiah:0.3;Dong:0.3;Zloty:0.4;Forint:0.3;Koruna:0.2;Lev;Leu;Naira:0.3;Shilling:0.3;Cedi;Kwacha;Birr;Taka;Kyat;Tenge;Som;Lari;Dram;Manat;Hryvnia;Quetzal;Colon;Lempira;Cordoba;Balboa;Sol;Bolivar;Guarani;Boliviano;Afghani;Rial;Ouguiya;Ariary;Pula;Loti;Lilangeni;Kina;Vatu;Tala;Pa'anga|paanga;Rufiyaa;Ngultrum;Kip;Riel;Pataca;Denar;Convertible mark|mark;Dalasi;Leone;Kwanza;Metical;Nakfa;Somoni;Tugrik|togrog" },

{ id: "ancient-wonders", text: "Name one of the Seven Wonders of the Ancient World", hint: "The classical list compiled by Greek writers", strip: ["the", "of", "at", "in"],
  answers: "Great Pyramid of Giza|pyramids|pyramid|great pyramid|pyramid giza|pyramids giza|giza:40;Hanging Gardens of Babylon|hanging gardens|gardens babylon:25;Colossus of Rhodes|colossus:12;Lighthouse of Alexandria|lighthouse|pharos|pharos alexandria:8;Statue of Zeus at Olympia|statue zeus|zeus olympia:6;Temple of Artemis at Ephesus|temple artemis|artemision:5;Mausoleum at Halicarnassus|mausoleum|mausoleum halicarnassus|tomb mausolus:4" },

{ id: "crustaceans", text: "Name a crustacean", hint: "Crabs, shrimp, barnacles and their relatives", strip: ["the"],
  answers: "Crab:30;Lobster:25;Shrimp:15;Prawn:6;Krill:5;Crayfish|crawfish|crawdad|yabby:4;Barnacle:2;Woodlouse|pill bug|pillbug|roly poly|sowbug:0.8;Copepod:0.4;Hermit crab:1.5;King crab:0.6;Mantis shrimp:0.8;Langoustine|scampi|norway lobster:0.3;Isopod|giant isopod:0.4;Amphipod:0.2;Sand hopper|beach hopper|sand flea:0.2;Water flea|daphnia:0.2;Brine shrimp|sea monkey|sea monkeys|artemia:0.2;Spider crab:0.3;Coconut crab|robber crab:0.3;Fiddler crab:0.2;Blue crab:0.2;Snow crab:0.2;Dungeness crab:0.2;Horseshoe crab;Spiny lobster|rock lobster;Slipper lobster;Squat lobster;Ghost crab;Mud crab;Tadpole shrimp;Fairy shrimp;Pistol shrimp|snapping shrimp;Cleaner shrimp;Ostracod|seed shrimp;Tongue-eating louse|tongue eating louse;Goose barnacle;Fish louse|sea louse;Pea crab;Decorator crab;Yeti crab" },

{ id: "dinosaurs", text: "Name a dinosaur", hint: "Pterosaurs and marine reptiles were not dinosaurs", strip: ["the"],
  answers: "Tyrannosaurus|t rex|trex|tyrannosaurus rex:35;Triceratops:15;Velociraptor|raptor:12;Stegosaurus:10;Brachiosaurus:5;Diplodocus:4;Ankylosaurus:3;Spinosaurus:3;Allosaurus:1.5;Iguanodon:1;Parasaurolophus:1;Pachycephalosaurus:0.6;Brontosaurus:2;Apatosaurus:0.6;Archaeopteryx:0.4;Compsognathus:0.3;Dilophosaurus:0.4;Gallimimus:0.3;Carnotaurus:0.3;Giganotosaurus:0.4;Argentinosaurus:0.3;Oviraptor:0.2;Deinonychus:0.2;Therizinosaurus:0.2;Utahraptor:0.2;Protoceratops;Styracosaurus;Megalosaurus;Baryonyx;Microraptor;Maiasaura;Edmontosaurus;Corythosaurus;Albertosaurus;Troodon;Coelophysis;Plateosaurus;Mamenchisaurus;Suchomimus;Kentrosaurus;Herrerasaurus;Eoraptor;Ceratosaurus;Carcharodontosaurus;Dreadnoughtus;Patagotitan;Nodosaurus;Euoplocephalus;Psittacosaurus;Lambeosaurus;Hadrosaurus;Camarasaurus;Sauropelta;Dracorex;Stygimoloch;Mapusaurus;Majungasaurus;Irritator;Tarbosaurus;Yutyrannus" },

{ id: "giant-moons", text: "Name a moon of Jupiter or Saturn", hint: "Named moons of either planet", strip: ["the", "moon"],
  answers: "Titan:30;Europa:22;Io:15;Ganymede:12;Callisto:6;Enceladus:6;Mimas:1.5;Rhea:1;Iapetus:1;Dione:0.8;Tethys:0.8;Hyperion:0.6;Phoebe:0.6;Pan:0.3;Atlas:0.2;Prometheus:0.2;Pandora:0.2;Janus:0.2;Epimetheus;Amalthea;Himalia;Thebe;Metis;Adrastea;Elara;Pasiphae;Carme;Ananke;Sinope;Lysithea;Leda;Daphnis;Helene;Calypso;Telesto;Methone;Pallene;Anthe;Polydeuces;Ymir;Paaliaq;Siarnaq;Tarvos;Kiviuq;Ijiraq;Mundilfari;Albiorix;Skathi;Erriapus;Narvi;Bestla;Fenrir;Thrymr;Callirrhoe;Themisto;Kalyke;Megaclite;Iocaste;Harpalyke;Praxidike;Taygete;Chaldene;Isonoe;Erinome;Aitne;Eurydome;Autonoe;Sponde;Kale;Hermippe;Thyone;Euanthe;Euporie;Orthosie;Herse;Valetudo;Dia;Carpo" },

{ id: "great-lakes", text: "Name one of North America's five Great Lakes", hint: "They straddle the US–Canada border", strip: ["the", "lake"],
  answers: "Superior:30;Michigan:30;Huron:13;Erie:15;Ontario:12" }
];

// Topic, difficulty and explanation for the original questions.
const META = {
  "oceans-seas": ["geography", "easy", "The Pacific is the largest and deepest ocean, covering about a third of Earth's surface."],
  "planets": ["space", "easy", "Since 2006 Pluto has been classed as a dwarf planet, leaving eight planets."],
  "brazil-borders": ["geography", "medium", "Brazil borders every South American country except Chile and Ecuador."],
  "sea-mammals": ["marine", "easy", "Marine mammals include whales and dolphins, seals and sea lions, manatees and dugongs, sea otters and polar bears."],
  "rainbow": ["general", "easy", "Newton named seven colours: red, orange, yellow, green, blue, indigo and violet."],
  "chess": ["general", "easy", "Each side starts with a king, a queen, two rooks, two bishops, two knights and eight pawns."],
  "bones": ["biology", "medium", "An adult skeleton has 206 bones; the femur is the longest and the stapes, in the ear, the smallest."],
  "edible-fish": ["general", "easy", "Salmon, tuna and cod are among the world's most widely eaten fish."],
  "elements": ["science", "easy", "118 elements are known; oganesson, element 118, was the last to be named, in 2016."],
  "africa": ["geography", "easy", "Africa has 54 UN member states, more than any other continent."],
  "orchestra": ["music", "easy", "A symphony orchestra groups its instruments into strings, woodwind, brass and percussion."],
  "tentacles": ["marine", "medium", "Octopuses have eight arms; squid and cuttlefish add two longer feeding tentacles."],
  "greek-gods": ["mythology", "easy", "The twelve Olympians lived on Mount Olympus, ruled by Zeus."],
  "root-veg": ["general", "easy", "Potatoes are tubers, carrots are taproots and onions are bulbs."],
  "gemstones": ["science", "medium", "Diamond is the hardest natural material, scoring 10 on the Mohs scale."],
  "ball-sports": ["general", "easy", "Football (soccer) is the world's most widely played and watched sport."],
  "mediterranean": ["geography", "medium", "Twenty-one countries have a Mediterranean coastline."],
  "constellations": ["space", "hard", "The IAU recognises 88 constellations that together cover the whole sky."],
  "flightless": ["animals", "easy", "The ostrich is the largest living bird; New Zealand's kiwi and kakapo are flightless too."],
  "sharks": ["marine", "medium", "The whale shark is the largest fish; the great white is the largest predatory fish."],
  "pacific-states": ["geography", "easy", "California, Oregon, Washington, Alaska and Hawaii all touch the Pacific."],
  "shakespeare": ["literature", "easy", "Shakespeare wrote around 39 plays: tragedies, comedies, histories and late romances."],
  "currencies": ["general", "medium", "The US dollar is the world's main reserve currency; the euro is shared by most EU member states."],
  "ancient-wonders": ["ancient", "easy", "Only the Great Pyramid of Giza, the oldest of the seven, still stands."],
  "crustaceans": ["marine", "easy", "Crustaceans have hard exoskeletons and jointed legs; krill are among the most numerous animals on Earth."],
  "dinosaurs": ["dinosaurs", "easy", "Dinosaurs lived from about 230 to 66 million years ago; birds are their living descendants."],
  "giant-moons": ["space", "medium", "Ganymede, orbiting Jupiter, is the largest moon in the solar system; Saturn's Titan has a thick atmosphere."],
  "great-lakes": ["geography", "easy", "Lake Superior is the largest freshwater lake in the world by surface area."],
  "euro-capitals": ["geography", "easy", "Vatican City is Europe's smallest capital; Moscow and London are its largest cities."],
  "stan-countries": ["geography", "easy", "The suffix '-stan' comes from Persian and means 'place' or 'land of'."],
  "south-america": ["geography", "easy", "South America has twelve sovereign countries; French Guiana is part of France."],
  "island-nations": ["geography", "medium", "Indonesia has more islands than any other country, over 17,000."],
  "canada-provinces": ["geography", "medium", "Canada has ten provinces and three territories."],
  "aus-states": ["geography", "medium", "Australia has six states plus the Northern Territory and the Australian Capital Territory."],
  "citrus": ["general", "easy", "Most citrus fruits are hybrids of a few ancestors, including the citron, mandarin and pomelo."],
  "pasta": ["general", "easy", "Italy has hundreds of pasta shapes, each suited to different sauces."],
  "cheese": ["general", "easy", "Cheddar takes its name from a village in Somerset, England."],
  "dog-breeds": ["animals", "easy", "The Labrador retriever has been one of the most popular breeds for decades."],
  "horse-breeds": ["animals", "medium", "The Arabian is one of the oldest horse breeds, prized for its stamina."],
  "collective-nouns": ["general", "hard", "Many group names, like a murder of crows, come from 15th-century books on hunting."],
  "greek-letters": ["general", "medium", "The Greek alphabet has 24 letters, from alpha to omega."],
  "noble-gases": ["science", "easy", "The noble gases sit in group 18 and rarely react because their outer electron shells are full."],
  "flower-parts": ["science", "medium", "The stamen (anther and filament) makes pollen; the pistil (stigma, style and ovary) receives it."],
  "clouds": ["science", "medium", "Clouds are classed by height and shape; towering cumulonimbus clouds bring thunderstorms."],
  "organs": ["biology", "easy", "The skin is the body's largest organ; the liver is the largest internal organ."],
  "muscles": ["biology", "medium", "The gluteus maximus is the body's largest muscle; the stapedius, in the ear, is the smallest."],
  "volcanoes": ["geography", "medium", "Vesuvius buried Pompeii and Herculaneum in AD 79."],
  "trees": ["general", "easy", "Coast redwoods are the tallest living trees, some over 115 metres."],
  "carnivorous-plants": ["science", "hard", "A Venus flytrap shuts when its trigger hairs are touched twice in quick succession."],
  "renaissance-painters": ["art", "medium", "Leonardo, Michelangelo and Raphael are often called the giants of the High Renaissance."],
  "dance-styles": ["art", "easy", "Ballet began in Italian Renaissance courts and was formalised in France."],
  "paris-2024": ["general", "medium", "Breaking made its Olympic debut at Paris 2024."],
  "eight-thousanders": ["geography", "hard", "Everest, at 8,849 m, is the highest; all fourteen are in the Himalaya and Karakoram."],
  "units-length": ["science", "easy", "The metre is defined by how far light travels in 1/299,792,458 of a second."],
  "molluscs": ["marine", "medium", "Molluscs include snails and slugs, bivalves like clams, and cephalopods like squid and octopuses."],
  "seabirds": ["marine", "easy", "The wandering albatross has the largest wingspan of any living bird, up to about 3.5 m."],
};

const OLD = [...BASE, ...require("./questions-more")];
for (const q of OLD) {
  const m = META[q.id];
  if (!m) throw new Error("no topic metadata: " + q.id);
  [q.topic, q.difficulty, q.explain] = m;
  delete q.cat;
}

// Per-topic bank files in ./bank (one file per topic; files starting with "_" are helpers).
const path = require("node:path"), fs = require("node:fs");
const BANK_DIR = path.join(__dirname, "bank");
const BANK = fs.readdirSync(BANK_DIR).filter(f => f.endsWith(".js") && !f.startsWith("_")).sort()
  .flatMap(f => require(path.join(BANK_DIR, f)));

module.exports = [...OLD, ...require("./q-general"), ...require("./q-nature"), ...require("./q-entertainment"), ...require("./q-culture"), ...BANK];
