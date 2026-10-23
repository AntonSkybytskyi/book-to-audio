import type { Language } from "../books/languages.js";

/**
 * What the benchmark reads: three scenes of plain prose with dialogue, a year, times, a count, a
 * price and a percentage, written for this app (so no licence applies) and the same story in every
 * language. The text goes through the same preparation as a chapter, so numbers are spelled out
 * where the rules say so and the speech rate is per character of what the engine is really given.
 */
export const BENCHMARK_SAMPLES: Readonly<Record<Language, string>> = {
  en: `The ferry left the quay at ten past seven, later than the timetable promised, and by the time it cleared the breakwater the fog had already swallowed the town. Marta stood at the rail with her coat buttoned to the chin and counted the bells of the harbour buoys, as her grandfather had taught her to do forty years before.

"You will catch cold out here," said the purser, who had come up on deck with a lantern. "It is only 4 degrees, and the wind is rising."

"I have been colder," she answered. "In January of 1987 the lake froze so hard that we drove across it. Do you remember that? No, of course you don't. You were not born yet."

He laughed and shook his head. The crossing would take about 3 hours and 20 minutes, he said, if the engines held, and the captain had already sent word that 112 passengers were to gather in the lower saloon. A ticket cost $15 for an adult and half that for a child, and nearly 60% of the seats were empty tonight.

Marta looked back at the place where the lights of the town had been. Somewhere behind the fog the clock on the customs house was striking the hour, slowly, as if it too were in no hurry to arrive.`,
  uk: `Пором відійшов від причалу о десятій хвилині на восьму, пізніше, ніж обіцяв розклад, і поки він минув хвилеріз, туман уже проковтнув місто. Марта стояла біля поруччя, застебнувши пальто під саму шию, і лічила дзвони портових бакенів, як навчив її дід сорок років тому.

— Ви застудитеся, — сказав касир, який вийшов на палубу з ліхтарем. — На дворі лише 4 градуси, а вітер посилюється.

— Мені бувало холодніше, — відповіла вона. — У січні 1987 року озеро замерзло так міцно, що ми переїхали його на машині. Пам'ятаєте? Ні, звісно, не пам'ятаєте. Вас ще не було на світі.

Він розсміявся і похитав головою. Переправа триватиме близько 3 годин 20 хвилин, сказав він, якщо витримають двигуни, а капітан уже передав, що 112 пасажирів мають зібратися в нижньому залі. Квиток коштує 150 гривень для дорослих і вдвічі менше для дітей, а майже 60% місць сьогодні вільні.

Марта озирнулася на те місце, де щойно світилися вогні міста. Десь за туманом годинник на митниці відбивав годину, повільно, ніби теж нікуди не поспішав.`,
  ru: `Паром отошёл от причала в десять минут восьмого, позже, чем обещало расписание, и к тому времени, когда он миновал волнолом, туман уже поглотил город. Марта стояла у борта, застегнув пальто до подбородка, и считала звон портовых буёв, как учил её дед сорок лет назад.

— Вы простудитесь, — сказал кассир, который вышел на палубу с фонарём. — На улице всего 4 градуса, а ветер крепчает.

— Мне бывало и холоднее, — ответила она. — В январе 1987 года озеро замёрзло так крепко, что мы переехали его на машине. Помните? Нет, конечно, не помните. Вас тогда ещё не было на свете.

Он засмеялся и покачал головой. Переправа займёт около 3 часов 20 минут, сказал он, если выдержат двигатели, а капитан уже передал, что 112 пассажиров должны собраться в нижнем зале. Билет стоит 150 рублей для взрослых и вдвое меньше для детей, а почти 60% мест сегодня свободны.

Марта оглянулась на то место, где только что светились огни города. Где-то за туманом часы на таможне отбивали час, медленно, словно тоже никуда не спешили.`,
};

/** A short line read first and not timed: the first chunk of a session pays for loading the model. */
export const WARM_UP: Readonly<Record<Language, string>> = {
  en: "Getting the voice ready.",
  uk: "Готуємо голос до роботи.",
  ru: "Готовим голос к работе.",
};
