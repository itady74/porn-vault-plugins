import { ActorContext, ActorOutput } from "../../types/actor";
import { Context } from "../../types/plugin";

interface MyContext extends ActorContext {
  args: {
    whitelist?: string[];
    blacklist?: string[];
    dry?: boolean;
    useImperial?: boolean;
    useAvatarAsThumbnail?: boolean;
    piercingsType?: "string" | "array";
    tattoosType?: "string" | "array";
  };
}

function lowercase(str: string): string {
  return str.toLowerCase();
}

function cmToFt(cm: number): number {
  cm *= 0.033;
  return Math.round((cm + Number.EPSILON) * 100) / 100;
}

function kgToLbs(kg: number): number {
  kg *= 2.2;
  return Math.round((kg + Number.EPSILON) * 100) / 100;
}

async function search({ $axios }: { $axios: Context["$axios"] }, query: string): Promise<string> {
  const url = `https://www.freeones.com/partial/subject`;
  return (
    await $axios.get(url, {
      params: {
        q: query,
      },
    })
  ).data;
}

async function getFirstSearchResult(ctx: MyContext, query: string): Promise<cheerio.Cheerio> {
  const searchHtml = await search(ctx, query);
  const $ = ctx.$cheerio.load(searchHtml);
  const el = $(".grid-item.teaser-subject>a");
  return el;
}

class Measurements {
  bust?: number;
  cup?: string;
  waist?: number;
  hip?: number;

  static fromString(str): Measurements | null {
    const [bra, waist, hip] = str.split("-");
    if (bra && waist && hip) {
      const measurements = new Measurements();
      measurements.bust = parseInt(bra);
      measurements.cup = bra.replace(measurements.bust, "");
      measurements.waist = Number(waist);
      measurements.hip = Number(hip);
      return measurements;
    }
    return null;
  }

  toString(): string {
    return `${this.braSize()}-${this.waist}-${this.hip}`;
  }

  braSize(): string {
    return `${this.bust}${this.cup}`;
  }
}

module.exports = async (ctx: MyContext): Promise<ActorOutput> => {
  const { $createImage, args, $axios, $moment, $cheerio, $throw, $log, actorName } = ctx;
  if (!actorName) $throw("Uh oh. You shouldn't use the plugin for this type of event");

  $log(`Scraping freeones date for ${actorName}, dry mode: ${args.dry || false}...`);

  const blacklist = (args.blacklist || []).map(lowercase);
  if (!args.blacklist) $log("No blacklist defined, returning everything...");
  if (blacklist.length) $log(`Blacklist defined, will ignore: ${blacklist.join(", ")}`);

  const whitelist = (args.whitelist || []).map(lowercase);
  if (whitelist.length) $log(`Whitelist defined, will only return: ${whitelist.join(", ")}...`);

  function isBlacklisted(prop): boolean {
    if (whitelist.length) {
      return !whitelist.includes(lowercase(prop));
    }
    return blacklist.includes(lowercase(prop));
  }

  // Check imperial unit preference
  const useImperial = args.useImperial;
  if (!useImperial) {
    $log("Imperial preference not set. Using metric values...");
  } else {
    $log("Imperial preference indicated. Using imperial values...");
  }

  // Check Use Avatar as Thumbnail preference
  const useAvatarAsThumbnail = args.useAvatarAsThumbnail;
  if (!useAvatarAsThumbnail) {
    $log("Will not use the Avatar as the Actor Thumbnail...");
  } else {
    $log("Will use the Avatar as the Actor Thumbnail...");
  }

  let firstResult: cheerio.Cheerio;
  try {
    firstResult = await getFirstSearchResult(ctx, actorName);
  } catch (error) {
    $throw(error.message);
    return {}; // return for type compatibility
  }

  if (!firstResult) $throw(`${actorName} not found!`);

  const href = firstResult.attr("href");

  let html: string;
  try {
    html = (await $axios.get(`https://freeones.com${href}/profile`)).data;
  } catch (error) {
    $throw(error.message);
    return {}; // return for type compatibility
  }
  const $ = $cheerio.load(html || "");

  function getNationality(): Partial<{ nationality: string }> {
    if (isBlacklisted("nationality")) return {};
    $log("Getting nationality...");

    const selector = $('[data-test="section-personal-information"] a[href*="countryCode%5D"]');

    if (!selector.length) {
      $log("Nationality not found");
      return {};
    }

    const nationality = ($(selector).attr("href") || "").split("=").slice(-1)[0];
    if (!nationality) {
      return {};
    }
    return {
      nationality,
    };
  }

  function getHeight(): Partial<{ height: number }> {
    if (isBlacklisted("height")) return {};
    $log("Getting height...");

    const selector = $('[data-test="link_height"] .text-underline-always');
    if (!selector) return {};

    const rawHeight = $(selector).text();
    const rawHeightMatch = rawHeight.match(/\d+cm/);
    const cm = rawHeightMatch ? rawHeightMatch[0] : null;
    if (!cm) return {};
    const height = parseInt(cm.replace("cm", ""));
    if (!useImperial) return { height };

    // Convert to imperial
    return { height: cmToFt(height) };
  }

  function getWeight(): Partial<{ weight: number }> {
    if (isBlacklisted("weight")) return {};
    $log("Getting weight...");

    const selector = $('[data-test="link_weight"] .text-underline-always');
    if (!selector) return {};

    const rawWeight = $(selector).text();
    const rawWeightMatch = rawWeight.match(/\d+kg/);
    const kg = rawWeightMatch ? rawWeightMatch[0] : null;
    if (!kg) return {};
    const weight = parseInt(kg.replace("kg", ""));
    if (!useImperial) return { weight };

    // Convert to imperial
    return { weight: kgToLbs(weight) };
  }

  function getZodiac(): Partial<{ zodiac: string }> {
    if (isBlacklisted("zodiac")) return {};
    $log("Getting zodiac sign...");

    const selector = $('[data-test="link_zodiac"] .text-underline-always');
    if (!selector) return {};
    const zodiacText = $(selector).text();
    const zodiac = zodiacText.split(" (")[0];
    return { zodiac };
  }

  function getBirthplace(): Partial<{ birthplace: string }> {
    if (isBlacklisted("birthplace")) return {};
    $log("Getting birthplace...");

    const selector = $('[data-test="section-personal-information"] a[href*="placeOfBirth"]');
    const cityName = selector.length
      ? ($(selector).attr("href") || "").split("=").slice(-1)[0]
      : null;

    if (!cityName) {
      $log("No birthplace found");
      return {};
    } else {
      const stateSelector = $('[data-test="section-personal-information"] a[href*="province"]');
      const stateName = stateSelector.length
        ? ($(stateSelector).attr("href") || "").split("=").slice(-1)[0]
        : null;
      if (!stateName) {
        $log("No birth province found, just city!");
        return { birthplace: cityName };
      } else {
        const bplace = cityName + ", " + stateName.split("-")[0].trim();
        return { birthplace: bplace };
      }
    }
  }

  function scrapeText<T extends Record<string, string>>(
    prop: string,
    selector: string
  ): Partial<T> {
    if (isBlacklisted(prop)) return {};
    $log(`Getting ${prop}...`);

    const el = $(selector);
    if (!el) return {};

    return { [prop]: el.text() } as T;
  }

  async function getAvatar(): Promise<Partial<{ avatar: string; thumbnail: string }>> {
    if (args.dry) return {};
    if (isBlacklisted("avatar")) return {};
    $log("Getting avatar...");

    const imgEl = $(`.dashboard-header img.img-fluid`);
    if (!imgEl) return {};

    const url = $(imgEl).attr("src");

    if (!url) return {};

    const imgId = await $createImage(url, `${actorName} (avatar)`);

    if (!useAvatarAsThumbnail) {
      return { avatar: imgId };
    } else {
      return {
        avatar: imgId,
        thumbnail: imgId,
      };
    }
  }

  function getAge(): Partial<{ bornOn: number }> {
    if (isBlacklisted("bornOn")) return {};
    $log("Getting age...");

    const aTag = $('[data-test="section-personal-information"] a');
    if (!aTag) return {};

    const href = $(aTag).attr("href") || "";
    const yyyymmdd = href.match(/\d\d\d\d-\d\d-\d\d/);

    if (yyyymmdd && yyyymmdd.length) {
      const date = yyyymmdd[0];
      const timestamp = $moment(date, "YYYY-MM-DD").valueOf();
      return {
        bornOn: timestamp,
      };
    } else {
      $log("Could not find actor birth date.");
      return {};
    }
  }

  function getAlias(): Partial<{ aliases: string[] }> {
    if (isBlacklisted("aliases")) return {};
    $log("Getting aliases...");

    const aliasSel = $('[data-test="section-alias"] p[data-test*="p_aliases"]');
    const aliasText = aliasSel.text();
    const aliasName = aliasText && !/unknown/.test(aliasText) ? aliasText.trim() : null;
    if (!aliasName) return {};
    const aliases = aliasName.split(/,\s*/g);

    return { aliases };
  }

  function scrapeMeasurements(): Measurements | null {
    const measurementParts: string[] = [];
    $('[data-test="p-measurements"] .text-underline-always').each(function (
      this: cheerio.Element,
      i,
      element
    ) {
      measurementParts[i] = $(this).text();
    });
    const measurements = measurementParts.join("-");
    return Measurements.fromString(measurements);
  }

  const measurements = scrapeMeasurements();

  function getMeasurements(): Partial<{ measurements: string }> {
    if (isBlacklisted("measurements")) return {};
    $log("Getting measurements...");
    return measurements ? { measurements: measurements.toString() } : {};
  }

  function getWaistSize(): Partial<{ ["waist size"]: number }> {
    if (isBlacklisted("measurements")) return {};
    $log("Getting waist size...");
    return measurements ? { "waist size": measurements.waist } : {};
  }

  function getHipSize(): Partial<{ ["hip size"]: number }> {
    if (isBlacklisted("measurements")) return {};
    $log("Getting hip size...");
    return measurements ? { "hip size": measurements.hip } : {};
  }

  function getBraSize(): Partial<{
    ["cup size"]: string;
    ["bra size"]: string;
    ["bust size"]: number;
  }> {
    if (isBlacklisted("measurements")) return {};
    $log("Getting bra/cup/bust size...");
    return measurements
      ? {
          "cup size": measurements.cup,
          "bra size": measurements.braSize(),
          "bust size": measurements.bust,
        }
      : {};
  }

  function getGender(): Partial<{ sex: string; gender: string }> {
    if (isBlacklisted("gender")) return {};
    return { sex: "Female", gender: "Female" };
  }

  function getTattoos(): Partial<{ tattoos: string | string[] }> {
    if (isBlacklisted("tattoos")) return {};
    let tattooResult = scrapeText<{ tattoos: string }>("tattoos", '[cdata-test="p_has_tattoos"]');
    if (!tattooResult["tattoos"]) {
      tattooResult = scrapeText<{ tattoos: string }>("tattoos", '[data-test="p_has_tattoos"]');
    }
    const tattooText = tattooResult["tattoos"] ? tattooResult["tattoos"].trim() : "";
    if (!tattooText || /No Tattoos/i.test(tattooText)) {
      return {};
    }

    if (args.tattoosType === "array") {
      return { tattoos: tattooText.split(";").map((s) => s.trim()) };
    }

    return { tattoos: tattooText };
  }

  function getPiercings(): Partial<{ piercings: string | string[] }> {
    if (isBlacklisted("piercings")) return {};
    const res: { piercings?: string } = scrapeText<{ piercings: string }>(
      "piercings",
      '[data-test="p_has_piercings"]'
    );
    const piercingText = res["piercings"]?.trim();
    if (!piercingText || /No Piercings/i.test(piercingText)) {
      return {};
    }

    if (args.piercingsType === "array") {
      return { piercings: piercingText.split(";").map((s) => s.trim()) };
    }

    return { piercings: piercingText };
  }

  const custom = {
    ...scrapeText<{ ["hair color"]: string }>(
      "hair color",
      '[data-test="link_hair_color"] .text-underline-always'
    ),
    ...scrapeText<{ ["eye color"]: string }>(
      "eye color",
      '[data-test="link_eye_color"] .text-underline-always'
    ),
    ...scrapeText<{ ethnicity: string }>(
      "ethnicity",
      '[data-test="link_ethnicity"] .text-underline-always'
    ),
    ...getHeight(),
    ...getWeight(),
    ...getMeasurements(),
    ...getWaistSize(),
    ...getHipSize(),
    ...getBraSize(),
    ...getBirthplace(),
    ...getZodiac(),
    ...getGender(),
    ...getTattoos(),
    ...getPiercings(),
  };

  if (custom.tattoos === "Unknown") {
    delete custom.tattoos;
  }

  const data: ActorOutput = {
    ...getNationality(),
    ...getAge(),
    ...getAlias(),
    ...(await getAvatar()),
    custom,
  };

  if (!isBlacklisted("labels")) {
    data.labels = [];
    if (custom["hair color"]) {
      data.labels.push(`${custom["hair color"]} Hair`);
    }
    if (custom["eye color"]) {
      data.labels.push(`${custom["eye color"]} Eyes`);
    }
    if (custom.ethnicity) {
      data.labels.push(custom.ethnicity);
    }
    if (custom.gender) {
      data.labels.push("Female");
    }
    if (custom["piercings"]) {
      data.labels.push("Piercings");
    }
    if (custom["tattoos"]) {
      data.labels.push("Tattoos");
    }
  }

  if (args.dry === true) {
    $log("Would have returned:", data);
    return {};
  }
  return data;
};
