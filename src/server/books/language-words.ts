// Word lists for `language-detect.ts`: frequent function words, lowercase. Only words that mark a
// language are in the Cyrillic lists (not "не", "на" or "до", which both languages use).

const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));

export const UKRAINIAN_WORDS = words(`
  і й що як це але він вона вони воно його її їх був була було були від із також ще вже
  який яка яке які мене мій цей тільки дуже лише чи бо ми ви є їй йому чого щоб якщо ніж
  коли ось їм цього цій цієї цих ці ніби навіть вона мені тобі собі
  дві двох їхній якого якій якому яких
`);

export const RUSSIAN_WORDS = words(`
  и что как это но он она они оно его её был была было были от из также ещё еще уже потому
  который которая которое которые меня тебя мой этот только очень лишь ли мы вы чтобы если или
  всё ей ему чем них этого этой этих эти тот ничего даже себя мне
  когда вот нет
`);

export const ENGLISH_WORDS = words(`
  the of and to a in that is was he for it with as his on be at by had i this from or but not
  are were she her they you we which have an there their all one been would said who will so
  if what my no out up into them him when could than then more some its only do has me about
`);

/** Function words of other Latin-script languages, to tell "not English" from "too little text". */
export const OTHER_LATIN_WORDS: readonly ReadonlySet<string>[] = [
  // German
  words(
    `der die das und ist nicht ich ein eine einen mit von zu den dem des sich auf für er sie es wir aber auch noch wie nach bei aus war wurde hat haben dass als wenn ihr ihre sein seine im am zum zur über unter nur schon sehr oder da dann doch`,
  ),
  // French
  words(
    `le la les de des du un une et est que qui dans pour pas sur au aux avec ne se ce il elle ils elles nous vous je tu mais ou où comme plus par son sa ses leur leurs été être avait`,
  ),
  // Spanish
  words(
    `el la los las de del un una y es que en por con para no se su sus al lo como más pero le ya o este porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos`,
  ),
  // Italian
  words(
    `il lo la i gli le di del della un una e è che in per con non si su come ma più anche da al alla sono era ha hanno`,
  ),
  // Portuguese
  words(
    `o a os as de do da dos das um uma e é que em para com não se por mais como mas foi ao ele ela são`,
  ),
  // Dutch
  words(`de het een en van ik te dat die in is niet op aan met als voor zijn er maar om hij ze zo`),
  // Polish and Czech share most of these
  words(`i w na z się nie to że do jest jak po co ale tak za od czy był była było a v je se že`),
];
