# تقييم مشاريع GitHub

تمت المراجعة في 10 أغسطس 2026. الترخيص والملاءمة أهم من عدد الـfeatures المكتوبة في README.

| المشروع | القرار | السبب |
|---|---|---|
| [FinOpenPOS](https://github.com/JoaoHenriqueBarbosa/FinOpenPOS) | أساس المشروع | MIT، حديث، Next.js/React/PostgreSQL، وفيه POS وتقارير ومصروفات. يحتاج بناء Restaurant domain وحذف Fiscal Brazil. |
| [Satisfecho POS](https://github.com/satisfecho/pos) | مرجع فقط | ناضج في المطاعم والمطبخ والمخزون، لكن AGPL يفرض التزامات نشر المصدر عند تقديمه عبر الشبكة، والـstack Angular/FastAPI. |
| [SimPOS](https://github.com/hieuhani/simpos) | مرجع Offline/Hardware | MIT ويدعم Offline/Tauri وطابعات، لكنه مرتبط بـOdoo كـbackend. |
| [Restaurant POS by Ahmed Ali](https://github.com/ahmedali5530/restaurant-pos) | غير مستخدم كقاعدة | Features ممتازة للمطاعم والعربية وOffline، لكن ترخيصه Source Available يقيّد SaaS والـwhite-label وإعادة البيع. |
| [Vertex POS](https://github.com/shreyanshjain1/Vertex-POS) | أفكار فقط | نموذج قوي للمخزون والشراء وOffline، لكن لم يظهر ترخيص واضح بالمستودع وقت المراجعة، كما أنه Retail وليس Restaurant. |
| [Next Smart POS](https://github.com/ArbazKhan1645/next-smart-pos) | غير مناسب | MIT لكن واجهة فقط تقريبًا، والـbackend والمخزون والـoffline غير مكتملة. |

## لماذا لم ننسخ مشروع Restaurant جاهزًا؟

المشاريع الأقرب وظيفيًا إما تحمل ترخيصًا غير مناسب لمنتج FORNO مملوك، أو تعتمد Stack مختلفًا، أو تفتقد المحاسبة الصحيحة للمكونات. اختيار أساس MIT نظيف ثم إضافة Restaurant domain يقلل المخاطرة القانونية والتقنية.
