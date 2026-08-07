fetch('https://kuronime.sbs/nonton-otome-kaijuu-carameliser-episode-6/', { redirect: 'manual' })
    .then(r => {
        console.log("Status:", r.status);
        console.log("Location Header:", r.headers.get('location'));
    })
    .catch(e => console.error(e));
