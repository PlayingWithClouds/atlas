"""Danbooru → atlas taxonomy mapping.

JoyTag predicts Danbooru vocabulary; the labeler works in the taxonomy from
atlas.config.json. Each atlas class lists the Danbooru tags that imply it; a
class's probability is the max over its tags. Classes without a usable
Danbooru equivalent (e.g. ass-to-mouth, gloryhole) are simply absent — JoyTag
cannot see them, so it never proposes them.

Every tag listed here was checked against the JoyTag top_tags.txt vocabulary;
a tag missing from the loaded vocabulary simply scores 0, so a stale entry
degrades to "unmapped" instead of breaking predictions.
"""

CLASS_TO_DANBOORU: dict[str, list[str]] = {
    # acts
    "vaginal": ["vaginal"],
    "anal": ["anal"],
    "blowjob": ["fellatio"],
    "pussy-eating": ["cunnilingus"],
    "handjob": ["handjob"],
    "fingering": ["fingering"],
    "titfuck": ["paizuri"],
    "footjob": ["footjob"],
    "deepthroat": ["deepthroat"],
    "facefuck": ["irrumatio"],
    "masturbation": ["masturbation", "female_masturbation"],
    "tit-grabbing": ["breast_grab"],
    "tit-sucking": ["breast_sucking"],
    "ass-grabbing": ["ass_grab"],
    "grinding": ["grinding"],
    "scissoring": ["tribadism"],
    "kissing": ["kiss"],
    "gape": ["gaping"],
    # positions
    "missionary": ["missionary"],
    "doggy": ["doggystyle"],
    "cowgirl": ["cowgirl_position", "girl_on_top"],
    "reverse-cowgirl": ["reverse_cowgirl_position"],
    "standing": ["standing_sex"],
    "prone-bone": ["prone_bone"],
    "sixtynine": ["69"],
    "mating-press": ["mating_press"],
    "against-wall": ["against_wall"],
    "legs-up": ["legs_up", "folded"],
    "suspended": ["suspension"],
    "kneeling": ["kneeling"],
    "bent-over": ["bent_over"],
    # finish
    "cumshot": ["ejaculation", "projectile_cum"],
    "facial": ["facial"],
    "creampie": ["cum_in_pussy", "cum_in_ass"],
    "cum-in-mouth": ["cum_in_mouth"],
    "cum-on-tits": ["cum_on_breasts"],
    "cum-on-ass": ["cum_on_ass"],
    "oral-creampie": ["cum_in_mouth"],
    "squirting": ["female_ejaculation"],
    "bukkake": ["bukkake"],
    "ahegao": ["ahegao"],
    # configuration
    "solo": ["solo"],
    "threesome": ["threesome"],
    "group": ["group_sex"],
    "gangbang": ["gangbang"],
    "double-penetration": ["double_penetration"],
    # framing
    "pov": ["pov"],
    "spreading": ["spread_pussy", "spread_anus"],
    # pose
    "presenting": ["presenting"],
    "stripping": ["undressing"],
    # setting
    "outdoor": ["outdoors"],
    "public": ["public_indecency"],
    "shower": ["bathing"],
    "car": ["car_interior"],
    # bdsm
    "bondage": ["bondage"],
    "choking": ["strangling", "asphyxiation"],
    "gagged": ["gagged", "gag", "ball_gag"],
    "blindfold": ["blindfold"],
    "collar-leash": ["leash", "collar"],
    # fetish
    "feet": ["feet", "foot_focus"],
    "pissing": ["peeing"],
    # state
    "clothed": ["clothed_sex"],
    "lingerie": ["lingerie"],
    "nude": ["nude", "completely_nude"],
    "toy": ["sex_toy", "dildo", "vibrator"],
    "saliva": ["saliva"],
    "stockings": ["thighhighs", "garter_straps"],
    "topless": ["topless"],
    "oiled": ["shiny_skin"],
    # production — visible on the frame, not inferred from the file
    "censored": ["censored", "mosaic_censoring", "bar_censor"],
    "subtitled": ["subtitled"],
    "on-screen-text": ["english_text", "text_focus"],
    "split-screen": ["multiple_views"],
    "low-light": ["dark", "backlighting"],
    # framing
    "pov-receiving": ["female_pov"],
    "mirror": ["mirror", "reflection"],
    "overhead": ["from_above"],
    "wide-shot": ["full_body", "wide_shot"],
    "eye-contact": ["looking_at_viewer"],
    # structure
    "aftermath": ["after_sex", "after_fellatio"],
    "dialogue": ["talking"],
    # state
    "panties-aside": ["panties_aside"],
    "partially-clothed": ["partially_undressed", "clothes_pull"],
    "heels": ["high_heels"],
    "wet": ["wet", "wet_clothes"],
    "condom": ["condom", "used_condom"],
    # bdsm — each names its own implement, so none of them shadows "bondage"
    # or the bare-handed "spanking" class
    "shibari": ["rope", "crotch_rope"],
    "impact-play": ["whip", "riding_crop", "paddle"],
    "hands-restrained": ["handcuffs", "cuffs", "restrained"],
    # acts / positions JoyTag could already propose; these were simply unmapped
    "face-sitting": ["sitting_on_face"],
    "lotus": ["upright_straddle"],
    "spanking": ["spanked"],
    "hair-pulling": ["grabbing_another's_hair"],
}
